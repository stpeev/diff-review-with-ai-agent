/**
 * Data processing pipeline
 * Fetches, transforms, and caches API data
 */

interface ApiResponse<T> {
    data: T;
    status: number;
    timestamp: number;
}

interface CacheEntry<T> {
    data: T;
    expiry: number;
}

const cache = new Map<string, CacheEntry<any>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchData<T>(endpoint: string): Promise<T> {
    // Check cache first
    const cached = cache.get(endpoint);
    if (cached && cached.expiry > Date.now()) {
        return cached.data;
    }

    const response = await fetch(endpoint);
    const json: ApiResponse<T> = await response.json();

    // Cache the result
    cache.set(endpoint, {
        data: json.data,
        expiry: Date.now() + CACHE_TTL,
    });

    return json.data;
}

export function transformData<T, R>(items: T[], transformer: (item: T) => R): R[] {
    return items.map(transformer);
}

export function filterByDate<T extends { createdAt: string }>(
    items: T[],
    startDate: string,
    endDate: string,
): T[] {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    return items.filter(item => {
        const created = new Date(item.createdAt).getTime();
        return created >= start && created <= end;
    });
}

export function aggregateByField<T>(items: T[], field: keyof T): Map<string, T[]> {
    const groups = new Map<string, T[]>();

    for (const item of items) {
        const key = String(item[field]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
    }

    return groups;
}

export function clearCache(): void {
    cache.clear();
}

export function getCacheStats(): { size: number; entries: string[] } {
    return {
        size: cache.size,
        entries: [...cache.keys()],
    };
}
