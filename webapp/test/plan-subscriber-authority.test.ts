import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    getAuthorityStalePlanSubscribers,
    getLivePlanSubscribers,
    type PlanSubscriberAuthorityStatus,
} from '../src/lib/plan-subscriber-authority.ts';

type Subscriber = {
    authorityStatus?: PlanSubscriberAuthorityStatus;
};

function subscriber(authorityStatus: PlanSubscriberAuthorityStatus): Subscriber {
    return {
        authorityStatus,
    };
}

test('classifies authority-rotated subscribers outside live collection sets', () => {
    const live = subscriber('live');
    const missing = subscriber('missing');
    const rotated = subscriber('rotated');
    const subscribers = [live, missing, rotated];

    assert.deepEqual(getLivePlanSubscribers(subscribers), [live]);
    assert.deepEqual(getAuthorityStalePlanSubscribers(subscribers), [missing, rotated]);
});
