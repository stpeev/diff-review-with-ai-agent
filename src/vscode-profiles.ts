/**
 * The VS Code-family install layout: which apps exist, where each keeps
 * `User/`, and which profiles under it keep their own per-profile config.
 * Shared by `mcp-consumers.ts` (MCP registration) and `slash-commands.ts`
 * (agent slash commands) — both write into a VS Code profile's own
 * directory and need the same platform-specific roots to find it.
 */
import * as path from 'path';

export interface AppSpec {
    id: string;
    label: string;
    /** Directory name under the platform's user-data root. */
    dir: string;
}

export const VSCODE_APPS: AppSpec[] = [
    { id: 'vscode', label: 'VS Code', dir: 'Code' },
    { id: 'vscode-insiders', label: 'VS Code Insiders', dir: 'Code - Insiders' },
    { id: 'vscodium', label: 'VSCodium', dir: 'VSCodium' },
    { id: 'cursor', label: 'Cursor', dir: 'Cursor' },
    { id: 'windsurf', label: 'Windsurf', dir: 'Windsurf' },
];

/**
 * The separator-correct `path` for a given target platform. Using the
 * ambient `path` module here would join with the *host* OS's separator
 * regardless of `platform`, which only matches production (where `platform`
 * is always the real host's) — a cross-platform unit test asking for a
 * win32 path from a POSIX host needs win32 separators back.
 */
function pathFor(platform: NodeJS.Platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** Where a platform keeps `<App>/User/`. */
export function userDataRoot(app: AppSpec, home: string, platform: NodeJS.Platform): string {
    const p = pathFor(platform);
    if (platform === 'win32') {
        const appData = process.env.APPDATA || p.join(home, 'AppData', 'Roaming');
        return p.join(appData, app.dir, 'User');
    }
    if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', app.dir, 'User');
    return p.join(home, '.config', app.dir, 'User');
}

export interface ProfileRef {
    /** Path under `profiles/`, which may be nested (e.g. "builtin/agents"). */
    location: string;
    name: string;
}

/**
 * The profiles listed in a VS Code family app's `storage.json`.
 *
 * `storage.json` is authoritative — directories under `profiles/` outlive the
 * profiles that made them, so a readdir invents rows for state VS Code
 * ignores.
 *
 * `defaultFlag`, when given, excludes profiles where
 * `useDefaultFlags[defaultFlag] === true` — such a profile reads the default
 * profile's config for that flag's feature, so it is not a separate target
 * for it. Callers with no flag of their own (nothing in VS Code's
 * `useDefaultFlags` schema governs slash-command prompts) pass nothing and
 * get every profile.
 */
export function parseProfiles(storageJson: string | null, defaultFlag?: string): ProfileRef[] {
    if (!storageJson) return [];
    let profiles: any;
    try { profiles = JSON.parse(storageJson).userDataProfiles; } catch { return []; }
    if (!Array.isArray(profiles)) return [];
    return profiles
        .filter(p => typeof p?.location === 'string' && typeof p?.name === 'string')
        .filter(p => !defaultFlag || p.useDefaultFlags?.[defaultFlag] !== true)
        .map(p => ({ location: p.location as string, name: p.name as string }));
}
