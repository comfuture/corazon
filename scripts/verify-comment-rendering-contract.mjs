#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  escapeHtmlCommentBody,
  escapeMarkdownLinkDestination,
  inlineCode,
  toSingleLine
} from './lib/comment-rendering-contract.mjs'

const singleLineCases = [
  {
    name: 'newlines are collapsed',
    input: 'release/`hotfix`\n${{ github.sha }}',
    expected: 'release/`hotfix` ${{ github.sha }}'
  },
  {
    name: 'tabs and extra spaces are normalized',
    input: '  a\t\tb   ',
    expected: 'a b'
  }
]

for (const testCase of singleLineCases) {
  assert.equal(toSingleLine(testCase.input), testCase.expected, testCase.name)
}

const inlineCodeCases = [
  {
    name: 'plain text uses single backticks',
    input: 'main',
    expected: '`main`'
  },
  {
    name: 'internal backticks promote fencing',
    input: 'release/`hotfix` ${{ github.sha }}',
    expected: '``release/`hotfix` ${{ github.sha }}``'
  },
  {
    name: 'leading backtick receives padded fence',
    input: '`old-state',
    expected: '`` `old-state ``'
  },
  {
    name: 'empty content stays representable',
    input: '',
    expected: '``'
  }
]

for (const testCase of inlineCodeCases) {
  assert.equal(inlineCode(testCase.input), testCase.expected, testCase.name)
}

const markdownLinkCases = [
  {
    name: 'closing parenthesis is escaped for markdown destination',
    input: 'https://example.test/run/88_(retry)',
    expected: 'https://example.test/run/88_(retry%29'
  }
]

for (const testCase of markdownLinkCases) {
  assert.equal(
    escapeMarkdownLinkDestination(testCase.input),
    testCase.expected,
    testCase.name
  )
}

const htmlCommentCases = [
  {
    name: 'comment terminator is neutralized',
    input: 'failure-after-retry-->',
    expected: 'failure-after-retry-- >'
  }
]

for (const testCase of htmlCommentCases) {
  assert.equal(escapeHtmlCommentBody(testCase.input), testCase.expected, testCase.name)
}

console.log('comment rendering contract checks passed')
