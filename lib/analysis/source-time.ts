const ISO_INSTANT_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseIsoInstant(value: string): Date | undefined {
    const match = ISO_INSTANT_PATTERN.exec(value);
    if (!match) {
        return undefined;
    }

    const [
        ,
        yearValue,
        monthValue,
        dayValue,
        hourValue,
        minuteValue,
        secondValue,
        fractionValue = '',
        timezoneValue,
        offsetSign,
        offsetHourValue = '0',
        offsetMinuteValue = '0',
    ] = match;
    const year = Number(yearValue);
    const month = Number(monthValue);
    const day = Number(dayValue);
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    const second = Number(secondValue);
    const millisecond = Number(`${fractionValue}000`.slice(0, 3));
    const offsetHour = Number(offsetHourValue);
    const offsetMinute = Number(offsetMinuteValue);

    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59
    ) {
        return undefined;
    }

    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
        return undefined;
    }

    const offsetMinutes =
        timezoneValue === 'Z'
            ? 0
            : (offsetSign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
    const localTime = new Date(parsed.getTime() + offsetMinutes * 60_000);
    if (
        localTime.getUTCFullYear() !== year ||
        localTime.getUTCMonth() !== month - 1 ||
        localTime.getUTCDate() !== day ||
        localTime.getUTCHours() !== hour ||
        localTime.getUTCMinutes() !== minute ||
        localTime.getUTCSeconds() !== second ||
        localTime.getUTCMilliseconds() !== millisecond
    ) {
        return undefined;
    }

    return parsed;
}

export function extractSourceAnalyzedAt(result: unknown, fallback?: Date): Date | undefined {
    if (result && typeof result === 'object' && 'analyzedAt' in result) {
        const value = (result as { analyzedAt?: unknown }).analyzedAt;
        if (typeof value === 'string') {
            const parsed = parseIsoInstant(value);
            if (parsed) {
                return parsed;
            }
        }
    }

    return fallback;
}

export function getAnalysisReferenceTime(row: {
    sourceAnalyzedAt?: Date | string | null;
    analyzedAt: Date | string;
}): Date {
    const sourceAnalyzedAt =
        row.sourceAnalyzedAt instanceof Date
            ? row.sourceAnalyzedAt
            : typeof row.sourceAnalyzedAt === 'string'
              ? parseIsoInstant(row.sourceAnalyzedAt)
              : undefined;
    if (sourceAnalyzedAt && Number.isFinite(sourceAnalyzedAt.getTime())) {
        return sourceAnalyzedAt;
    }

    return new Date(row.analyzedAt);
}
