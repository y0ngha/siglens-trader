export function verifyCronSecret(req: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const auth = req.headers.get('authorization');
    return auth === `Bearer ${secret}`;
}
