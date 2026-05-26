export type PlanSubscriberAuthorityStatus = 'live' | 'missing' | 'rotated';

export interface PlanSubscriberAuthorityFields {
    authorityStatus?: PlanSubscriberAuthorityStatus;
}

export function getLivePlanSubscribers<T extends PlanSubscriberAuthorityFields>(subscribers: T[]): T[] {
    return subscribers.filter(subscriber => subscriber.authorityStatus === 'live');
}

export function getAuthorityStalePlanSubscribers<T extends PlanSubscriberAuthorityFields>(subscribers: T[]): T[] {
    return subscribers.filter(
        subscriber => subscriber.authorityStatus === 'missing' || subscriber.authorityStatus === 'rotated',
    );
}
