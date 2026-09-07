/**
 * The single authored statement of *how an agent must act on a diff review
 * comment thread*: triage it, reply, resolve only what it actually did, never
 * commit, then report.
 *
 * Two consumers embed it, and before this module existed they each carried
 * their own hand-maintained copy that had already drifted apart:
 *
 * - `slash-commands.ts` — the `/address-diff-review` command body installed
 *   into Claude / Codex / Gemini / VS Code prompt directories. The agent there
 *   discovers threads itself by calling `listDiffComments`.
 * - `extension.ts`'s `buildPrompt` — the prompt behind every "send to chat" /
 *   "copy to clipboard" action, where the threads are already inlined in the
 *   text above the policy, each headed with its `(Thread #N)` id.
 *
 * The two differ in exactly two ways, so both are parameters: how a thread is
 * identified (`threadRef`), and what the reply/resolve tools are *called* in
 * the consumer's session — MCP names (`replyToDiffComment`) for the slash
 * commands, VS Code language-model tool names (`diffReview_replyToComment`,
 * registered in `registerTools`) for the chat prompt. Everything else is one
 * thing to author and one thing to review.
 *
 * Pure: no `vscode` import, so it is requirable under plain `node --test`.
 * See test/review-policy.test.js.
 */

/** What the reply and resolve tools are called in the target agent's session. */
export interface PolicyTools {
    reply: string;
    resolve: string;
}

/** How the agent gets hold of the threads it is being asked to work. */
export type ThreadRef =
    /** Threads are inlined in the prompt, each headed with `(Thread #N)`. */
    | 'inline'
    /** The agent lists threads itself through the MCP server. */
    | 'listed';

export interface PolicyOptions {
    tools: PolicyTools;
    threadRef: ThreadRef;
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
 * The policy as a list of `{ heading, body }` steps, so each consumer can
 * render them at whatever heading level and numbering its surrounding document
 * uses — `sectionedPolicy` and `prosePolicy` below are the two renderings in
 * use. Steps are ordered: triage, reply, resolve, never commit, report.
 */
export function addressSteps({ tools, threadRef }: PolicyOptions): { heading: string; body: string }[] {
    const identify = threadRef === 'inline'
        ? 'Each comment heading carries its thread ID as "(Thread #N)"; use that N as the threadId ' +
          'for the tools below.'
        : 'Work them oldest-first.';

    return [
        {
            heading: 'Work each open thread',
            body: `${identify} Read the full thread and the surrounding context. Determine whether the ` +
                'comment requests a discussion, a design-document revision, or an implementation change, ' +
                'then act on it.',
        },
        {
            heading: 'Reply to every thread you touch',
            body: `Call \`${tools.reply}\` (with threadId and text) stating exactly what changed — or, if ` +
                'you decided not to change anything, why not. Do not resolve a thread without replying to ' +
                'it first.',
        },
        {
            heading: 'Resolve only what you actually addressed',
            body: `Call \`${tools.resolve}\` (with threadId) only on threads you changed code for (or ` +
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
 * is wrapped the same way; the prose rendering goes into a chat prompt, where
 * wrapping buys nothing, so it is left as one line per step.
 */
function wrap(text: string, width = 76): string {
    const out: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
        if (line === '') line = word;
        else if (line.length + 1 + word.length <= width) line += ` ${word}`;
        else { out.push(line); line = word; }
    }
    if (line !== '') out.push(line);
    return out.join('\n');
}

/**
 * The policy as numbered Markdown sections, for a document that already has
 * steps of its own. `startAt` is the number of the first policy step, so a
 * caller with a preamble step can continue its own numbering.
 */
export function sectionedPolicy(opts: PolicyOptions, startAt = 1): string {
    return addressSteps(opts)
        .map((step, i) => `### ${startAt + i}. ${step.heading}\n\n${wrap(step.body)}\n`)
        .join('\n');
}

/**
 * The policy as flat prose with a bullet per step, for a prompt that is a
 * stream of text rather than a structured document.
 */
export function prosePolicy(opts: PolicyOptions): string {
    return addressSteps(opts)
        .map(step => `- **${step.heading}.** ${step.body}`)
        .join('\n');
}
