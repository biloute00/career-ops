#!/usr/bin/env node
/**
 * career-ops — UserPromptSubmit hook.
 *
 * When onboarding is done (cv.md exists) and the user's message contains a URL,
 * restate the simple-mode flow right next to that message, so it is fresh when
 * the long career-ops mode files load. Plain stdout becomes agent context.
 * Never blocks the prompt.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const prompt = String(input.prompt || '');
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (/https?:\/\/\S+/i.test(prompt) && existsSync(join(project, 'cv.md'))) {
    process.stdout.write([
      'career-ops simple mode reminder (job URL received): run the auto-pipeline evaluation;',
      'add "## Your Chances" to the report; the HTML report is generated automatically when the report is written —',
      'display it with SendUserFile display "render" and mention it; score < 3.5 → advise against and stop;',
      'otherwise one message (verdict, 3 reasons, 3 risks, « Qu\'est-ce qui vous attire dans cette entreprise ? » with pre-filled proposals);',
      'every tailored CV PDF must also be displayed with display "render". Messages in French, documents in the posting\'s language.',
    ].join(' '));
  }
} catch { /* never block the prompt */ }
process.exit(0);
