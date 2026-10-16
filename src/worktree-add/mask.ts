import type { Env } from './types.ts';

const MASK = '***';
const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|AUTH|KEY/iu;
const URL_CREDENTIALS = /\b([a-z][\d+.a-z-]*:\/\/)([^\s/:@]*)(:[^\s/@]+)?@/giu;
const AUTH_SETTING = /\b(_authToken|_auth|_password|npmAuthToken|npmAuthIdent)(\s*[:=]\s*)["']?[^\s"',]+["']?/giu;

function secretEnvValues(env: Env): string[] {
    const values: string[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) {
            values.push(value);
        }
    }
    return values.toSorted((left, right) => right.length - left.length);
}

// A user with a password keeps the user name; a user alone is often a token, so the whole userinfo is hidden.
function maskUrlCredentials(_match: string, scheme: string, user: string, password: string | undefined): string {
    return password === undefined ? `${scheme}${MASK}@` : `${scheme}${user}:${MASK}@`;
}

// Secret env values go first so a token embedded in a URL or a setting is hidden even when the patterns miss it.
export function maskSecrets(text: string, env: Env): string {
    let masked = text;
    for (const value of secretEnvValues(env)) {
        masked = masked.replaceAll(value, MASK);
    }
    return masked.replaceAll(URL_CREDENTIALS, maskUrlCredentials).replaceAll(AUTH_SETTING, `$1$2${MASK}`);
}
