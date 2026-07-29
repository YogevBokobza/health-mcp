import { describe, expect, it } from 'vitest';
import { HealthFundTypes } from 'israeli-health-scrapers';

import { operationsFor } from '../src/operations.js';
import { PermissionEngine } from '../src/permissions/engine.js';
import type { ResolvedPolicy } from '../src/permissions/config.js';
import { toolNameFor } from '../src/mcp/tools.js';

const maccabiOperations = operationsFor(HealthFundTypes.maccabi);

function policy(scopes: string[]): ResolvedPolicy {
  return {
    profileName: 'fictional-test-profile',
    readOnlyMode: false,
    profile: {
      scopes,
      requireConfirmation: [],
      rateLimits: {},
    },
  };
}

describe('test-result operations', () => {
  it('registers exactly the six supported Maccabi resource operations', () => {
    expect(maccabiOperations.map((operation) => operation.name)).toEqual([
      'medications.list',
      'medications.refresh',
      'appointments.list',
      'appointments.refresh',
      'testResults.list',
      'testResults.refresh',
    ]);
  });

  it('classifies test-result listing and refresh as scoped reads', () => {
    const testResultOperations = maccabiOperations.filter(
      (operation) => operation.resource === 'testResults',
    );

    expect(testResultOperations).toHaveLength(2);
    expect(
      testResultOperations.map(({ name, resource, capability, scope }) => ({
        name,
        resource,
        capability,
        scope,
      })),
    ).toEqual([
      {
        name: 'testResults.list',
        resource: 'testResults',
        capability: 'read',
        scope: 'maccabi:testResults:read',
      },
      {
        name: 'testResults.refresh',
        resource: 'testResults',
        capability: 'read',
        scope: 'maccabi:testResults:read',
      },
    ]);
  });

  it('discovers test-result operations only when their scope is granted', () => {
    const testResultGrant = new PermissionEngine(policy(['maccabi:testResults:read']));
    const medicationGrant = new PermissionEngine(policy(['maccabi:medications:read']));

    expect(testResultGrant.visibleOperations(maccabiOperations).map((operation) => operation.name)).toEqual([
      'testResults.list',
      'testResults.refresh',
    ]);
    expect(
      medicationGrant
        .visibleOperations(maccabiOperations)
        .some((operation) => operation.resource === 'testResults'),
    ).toBe(false);
  });

  it('uses stable unqualified and fund-qualified tool names', () => {
    const list = maccabiOperations.find((operation) => operation.name === 'testResults.list')!;
    const refresh = maccabiOperations.find((operation) => operation.name === 'testResults.refresh')!;

    expect(toolNameFor(list, false)).toBe('testResults_list');
    expect(toolNameFor(refresh, false)).toBe('testResults_refresh');
    expect(toolNameFor(list, true)).toBe('maccabi_testResults_list');
    expect(toolNameFor(refresh, true)).toBe('maccabi_testResults_refresh');
  });
});
