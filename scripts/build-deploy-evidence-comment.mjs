#!/usr/bin/env node

import { buildDeployEvidenceCommentBody } from './lib/deploy-evidence-comment-body.mjs'

const body = buildDeployEvidenceCommentBody({
  state: process.env.DEPLOY_EVIDENCE_STATE,
  branch: process.env.DEPLOY_EVIDENCE_BRANCH,
  headSha: process.env.DEPLOY_EVIDENCE_HEAD_SHA,
  runNumber: process.env.DEPLOY_EVIDENCE_RUN_NUMBER,
  runAttempt: process.env.DEPLOY_EVIDENCE_RUN_ATTEMPT,
  runUrl: process.env.DEPLOY_EVIDENCE_RUN_URL,
  conclusion: process.env.DEPLOY_EVIDENCE_CONCLUSION,
  previousState: process.env.DEPLOY_EVIDENCE_PREVIOUS_STATE
})

process.stdout.write(body)
