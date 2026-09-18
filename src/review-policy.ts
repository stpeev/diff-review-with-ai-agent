/**
 * The single authored statement of *how an agent acts on a diff review
 * comment thread*: triage it, reply, resolve only what it actually did,
 * never commit, then report.
 *
 * One consumer embeds it: `slash-commands.ts`, whose `/address-diff-review`
 * body is installed into Claude / Codex / Gemini / VS Code prompt
 * directories, where the agent discovers threads itself by calling
 * `listDiffComments`. That command is a procedure the user invokes
 * explicitly, so it reads as one.
 *
 * The chat/direct prompt (`review/prompt.ts`) is deliberately *not* a second
 * embedder: it carries the comment payload and one closing line that names
 * the tools, so it reads like a normal chat message. `prosePolicy` used to
 * render this policy into it; do not bring that back.
 *
 * `tools` is a parameter because the reply/resolve tools are *called*
 * differently in each session — MCP names (`replyToDiffComment`) for agents
 * connected to the MCP server, VS Code language-model tool names
 * (`diffReview_replyToComment`, registered in `registerTools`) for in-editor
 * chat. Everything else is one thing to author and one thing to review.
 *
 * Pure: no `vscode` import, so it is requirable under plain `node --test`.
 * See src/review-policy.test.ts.
 */

/** What the reply and resolve tools are called in the target agent's session. */
export interface PolicyTools {
  reply: string;
  resolve: string;
}

/** The MCP tool names, used by the installed slash commands. */
export const MCP_TOOLS: PolicyTools = {
  reply: 'replyToDiffComment',
  resolve: 'resolveDiffComment',
};

/** The VS Code language-model tool names, used by the in-editor chat prompt. */
export const LM_TOOLS: PolicyTools = {
  reply: 'diffReview_replyToComment',
  resolve: 'diffReview_resolveComment',
};

/**
 * The policy as a list of `{ heading, body }` steps, so the consumer can
 * render them at whatever heading level and numbering its surrounding
 * document uses — `sectionedPolicy` below is the rendering in use. Steps are
 * ordered: triage, reply, resolve, never commit, report.
 *
 * The first step's wording assumes the `listed` thread source (the agent
 * calls `listDiffComments` itself). It is kept byte-identical on purpose:
 * slash-command bodies carry a versioned ownership marker, so an unchanged
 * body means previously installed files are recognized and not rewritten.
 */
export function addressSteps(tools: PolicyTools): { heading: string; body: string }[] {
  return [
    {
      heading: 'Inspect each open thread',
      body:
        'Go through them oldest-first. Read the full thread and the surrounding context, then decide how to ' +
        'handle it — answer, edit a doc, or change code.',
    },
    {
      heading: 'Reply to every thread you touch',
      body:
        `Call \`${tools.reply}\` (with threadId and text) stating exactly what changed — or, if ` +
        'you decided not to change anything, why not. Do not resolve a thread without replying to ' +
        'it first.',
    },
    {
      heading: 'Resolve only what you actually addressed',
      body:
        `Call \`${tools.resolve}\` (with threadId) only on threads you changed code for (or ` +
        'explicitly decided, with a stated reason, needed no change). Leave anything you could ' +
        'not act on open.',
    },
    {
      heading: 'Never commit',
      body: "Committing stays the user's call.",
    },
    {
      heading: 'Report',
      body: 'State what you addressed, what you left open, and why.',
    },
  ];
}

/**
 * Soft-wrap a paragraph at `width` columns. The sectioned rendering is written
 * into files a human reviews in a diff, and the hand-authored prose around it
 * is wrapped the same way.
 */
function wrap(text: string, width = 76): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out.join('\n');
}

/**
 * The policy as numbered Markdown sections, for a document that already has
 * steps of its own. `startAt` is the number of the first policy step, so a
 * caller with a preamble step can continue its own numbering.
 */
export function sectionedPolicy(tools: PolicyTools, startAt = 1): string {
  return addressSteps(tools)
    .map((step, i) => `### ${startAt + i}. ${step.heading}\n\n${wrap(step.body)}\n`)
    .join('\n');
}
