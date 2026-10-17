import {
  getBooleanInput,
  getInput,
  getMultilineInput,
  info,
  setFailed,
  warning
} from '@actions/core'
import {context} from '@actions/github'
import pLimit from 'p-limit'
import {Bot} from './bot'
import {Commenter} from './commenter'
import {Inputs} from './inputs'
import {octokit} from './octokit'
import {OpenAIOptions, Options} from './options'
import {Prompts} from './prompts'
import {
  chunkFilePatches,
  parsePatch,
  parseReview,
  Review,
  splitPatch
} from './review'
import {getTokenCount} from './tokenizer'

interface ReviewFinding {
  path: string
  startLine: number
  endLine: number
  comment: string
}

async function run(): Promise<void> {
  // Validate trigger event
  if (
    context.eventName !== 'pull_request' &&
    context.eventName !== 'pull_request_target'
  ) {
    warning(
      `Skipped: Secure-AI-Code-Review-Action only runs on pull_request or pull_request_target events (received: ${context.eventName})`
    )
    return
  }

  const pr = context.payload.pull_request
  if (!pr) {
    warning('Skipped: context.payload.pull_request is undefined')
    return
  }

  const repo = context.repo
  const pullNumber = pr.number
  const baseSha = pr.base.sha
  const headSha = pr.head.sha
  const prTitle = pr.title ?? 'No title provided'
  const prDescription = pr.body ?? 'No description provided'

  // Load action options
  const options = new Options(
    getBooleanInput('debug'),
    getBooleanInput('disable_review'),
    getInput('max_files'),
    getBooleanInput('review_simple_changes'),
    getBooleanInput('review_comment_lgtm'),
    getMultilineInput('path_filters'),
    getInput('system_message'),
    getInput('openai_light_model'),
    getInput('openai_heavy_model'),
    getInput('openai_model_temperature'),
    getInput('openai_retries'),
    getInput('openai_timeout_ms'),
    getInput('openai_concurrency_limit'),
    getInput('github_concurrency_limit'),
    getInput('openai_base_url')
  )

  if (options.debug) {
    options.print()
  }

  if (options.disableReview) {
    info('Review is disabled via disable_review option.')
    return
  }

  // Initialize OpenAI Security Review Bot
  let bot: Bot
  try {
    bot = new Bot(
      options,
      new OpenAIOptions(options.openaiHeavyModel, options.heavyTokenLimits)
    )
  } catch (e: any) {
    setFailed(
      `Failed to initialize OpenAI API client. Ensure OPENAI_API_KEY is configured: ${e.message}`
    )
    return
  }

  const prompts = new Prompts(getInput('summarize'))
  const commenter = new Commenter()
  const openaiLimit = pLimit(options.openaiConcurrencyLimit)

  // =========================================================================
  // STEP 1: Fetch the PR diff
  // =========================================================================
  info(`Fetching diff for PR #${pullNumber} (${baseSha} -> ${headSha})...`)
  const comparison = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: baseSha,
    head: headSha
  })

  const rawFiles = comparison.data.files ?? []
  if (rawFiles.length === 0) {
    info('No changed files found in this PR.')
    return
  }

  // Filter files by user path filters and patch availability
  const eligibleFiles = rawFiles.filter(file => {
    if (!file.patch) return false
    return options.checkPath(file.filename)
  })

  const filesToReview =
    options.maxFiles > 0
      ? eligibleFiles.slice(0, options.maxFiles)
      : eligibleFiles

  if (filesToReview.length === 0) {
    info('No files matched path filters for review.')
    return
  }

  info(`Processing ${filesToReview.length} files for security review...`)

  // =========================================================================
  // STEP 2: Chunk the diff if it exceeds context limits
  // =========================================================================
  interface ReviewTask {
    filename: string
    patches: Array<[number, number, string]>
  }

  const reviewTasks: ReviewTask[] = []

  for (const file of filesToReview) {
    const rawPatches = splitPatch(file.patch)
    const validPatches: Array<[number, number, string]> = []

    for (const rawPatch of rawPatches) {
      const hunks = parsePatch(rawPatch)
      if (!hunks) continue

      const lines = rawPatch.match(/(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/m)
      if (!lines) continue

      const startLine = parseInt(lines[4], 10)
      const diffLength = parseInt(lines[5], 10)
      const endLine = startLine + diffLength - 1

      const formattedHunk = `---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`
      validPatches.push([startLine, endLine, formattedHunk])
    }

    if (validPatches.length === 0) continue

    // Calculate token budget per chunk
    const testInput = new Inputs(
      options.systemMessage,
      prTitle,
      prDescription,
      '',
      '',
      file.filename,
      '',
      '',
      '',
      '',
      '',
      ''
    )
    const basePromptTokens = getTokenCount(
      prompts.renderReviewFileDiff(testInput)
    )
    const tokenLimit = options.heavyTokenLimits.requestTokens
    const maxChunkTokens = Math.max(1000, tokenLimit - basePromptTokens - 500)

    // Split patches into chunks respecting model context limits
    const chunkedPatches = chunkFilePatches(validPatches, maxChunkTokens)
    for (const chunk of chunkedPatches) {
      reviewTasks.push({
        filename: file.filename,
        patches: chunk
      })
    }
  }

  if (reviewTasks.length === 0) {
    info('No reviewable code hunks found.')
    return
  }

  // =========================================================================
  // STEP 3: Send diff chunks to the customized OpenAI prompt
  // =========================================================================
  info(
    `Submitting ${reviewTasks.length} diff chunk(s) to OpenAI (${options.openaiHeavyModel})...`
  )
  const findings: ReviewFinding[] = []

  const reviewPromises = reviewTasks.map(task =>
    openaiLimit(async () => {
      const inputs = new Inputs(
        options.systemMessage,
        prTitle,
        prDescription,
        '',
        '',
        task.filename,
        '',
        '',
        task.patches.map(p => p[2]).join('\n'),
        '',
        '',
        ''
      )

      const reviewPrompt = prompts.renderReviewFileDiff(inputs)

      try {
        const [response] = await bot.chat(reviewPrompt, {})
        if (!response) {
          info(`No response received for chunk in ${task.filename}`)
          return
        }

        const parsedReviews: Review[] = parseReview(
          response,
          task.patches,
          options.debug
        )
        for (const r of parsedReviews) {
          findings.push({
            path: task.filename,
            startLine: r.startLine,
            endLine: r.endLine,
            comment: r.comment
          })
        }
      } catch (err: any) {
        warning(`Error reviewing chunk in ${task.filename}: ${err.message}`)
      }
    })
  )

  await Promise.all(reviewPromises)

  // =========================================================================
  // STEP 4: Post a single, consolidated GitHub PR review comment with line annotations
  // =========================================================================
  info(
    `Security review completed. Found ${findings.length} issue(s) across ${filesToReview.length} files.`
  )

  // Prepare line-item annotations
  const annotations = findings.map(f => {
    const commentData: any = {
      path: f.path,
      body: f.comment,
      line: f.endLine
    }
    if (f.startLine !== f.endLine) {
      commentData.start_line = f.startLine
      commentData.start_side = 'RIGHT'
    }
    return commentData
  })

  // Format executive review summary
  let consolidatedBody = `## 🛡️ Secure-AI-Code-Review-Action Report

### 📊 Executive Security Summary
- **Scanned Files:** ${filesToReview.length}
- **Security Findings & Gaps:** ${findings.length}
`

  if (findings.length > 0) {
    consolidatedBody += `\n### ⚠️ Critical Findings Requiring Attention Before Merging
The following security vulnerabilities, concurrency risks, unhandled exceptions, or missing unit tests were identified:

${findings
  .map(
    f =>
      `- **\`${f.path}\` (L${f.startLine}${
        f.startLine !== f.endLine ? `-${f.endLine}` : ''
      }):** ${f.comment.split('\n')[0]}`
  )
  .join('\n')}

*Please inspect the line-item annotations below for specific remediation code and recommendations.*`
  } else {
    consolidatedBody += `\n### ✅ Security & Quality Audit Passed
No OWASP Top 10 vulnerabilities, race conditions, unhandled exceptions, missing unit tests, or hardcoded secrets were detected. LGTM! 🚀`
  }

  consolidatedBody += `\n\n---\n*Automated DevSecOps Review performed by **Secure-AI-Code-Review-Action***`

  // Delete any lingering pending reviews
  await commenter.deletePendingReview(pullNumber)

  // Post consolidated review with annotations
  try {
    await octokit.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body: consolidatedBody,
      comments: annotations
    })
    info(
      `Posted single consolidated PR review with ${annotations.length} line-item annotation(s).`
    )
  } catch (error: any) {
    warning(
      `Failed to post review with line-item annotations (${error.message}). Submitting consolidated review body as fallback...`
    )

    // Fallback if line mapping is rejected by GitHub API
    let fallbackBody = consolidatedBody
    if (findings.length > 0) {
      fallbackBody += `\n\n### 📝 Detailed Findings:\n`
      for (const f of findings) {
        fallbackBody += `\n#### \`${f.path}\` (Lines ${f.startLine}-${f.endLine})\n${f.comment}\n`
      }
    }

    try {
      await octokit.pulls.createReview({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body: fallbackBody
      })
      info('Posted fallback consolidated PR review.')
    } catch (fallbackError: any) {
      setFailed(
        `Failed to submit PR review to GitHub: ${fallbackError.message}`
      )
    }
  }
}

process
  .on('unhandledRejection', (reason, p) => {
    warning(`Unhandled Rejection at Promise: ${reason}, promise is ${p}`)
  })
  .on('uncaughtException', (e: any) => {
    warning(`Uncaught Exception thrown: ${e}, backtrace: ${e.stack}`)
  })

await run()
