export function verifyCronSecret(req: Request): boolean {
    const auth = req.headers.get('authorization');
    return auth === `Bearer ${process.env.CRON_SECRET}`;
}
