export function isAuthenticated(req: Request): boolean {
    // In production, Cloudflare Access sets this header for authenticated users
    const cfEmail = req.headers.get('cf-access-authenticated-user-email');
    if (cfEmail) return true;

    // Explicit opt-in for local development (set DISABLE_AUTH=true in .env.local)
    if (process.env.DISABLE_AUTH === 'true') return true;

    return false;
}
