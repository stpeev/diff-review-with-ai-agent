const RELEVANT_ENV = /^(CODEX|CLAUDE|VSCODE|MCP|TERM|PWD$)|(?:SESSION|THREAD|TURN|WORKSPACE)/i;
const SENSITIVE_KEY = /(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH|COOKIE|CREDENTIAL)/i;

export function diagnosticEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env)
            .filter(([key, value]) => value !== undefined && RELEVANT_ENV.test(key))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? '<redacted>' : value!])
    );
}

export function sanitizeDiagnostic(value: unknown, key = '', depth = 0): unknown {
    if (SENSITIVE_KEY.test(key)) return '<redacted>';
    if (depth >= 5) return '<max-depth>';
    if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeDiagnostic(item, '', depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .map(([childKey, child]) => [childKey, sanitizeDiagnostic(child, childKey, depth + 1)]));
    }
    if (typeof value === 'string' && value.length > 1000) return value.slice(0, 1000) + '…';
    return value;
}
