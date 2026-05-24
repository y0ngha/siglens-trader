export function isAuthenticated(req: Request): boolean {
    // In production, Cloudflare Access sets this header for authenticated users
    const cfEmail = req.headers.get('cf-access-authenticated-user-email');
    if (cfEmail) return true;

    // In development, allow all requests (no Cloudflare Access)
    if (process.env.NODE_ENV === 'development' || process.env.VERCEL_ENV === 'development')
        return true;

    // Fallback: allow when not running on Vercel (local dev without NODE_ENV set)
    return !process.env.VERCEL;
}
