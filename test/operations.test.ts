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
  it('registers exactly the ten supported Maccabi resource operations', () => {
    expect(maccabiOperations.map((operation) => operation.name)).toEqual([
      'medications.list',
      'medications.refresh',
      'appointments.list',
      'appointments.refresh',
      'testResults.list',
      'testResults.refresh',
      'vaccinations.list',
      'vaccinations.refresh',
      'form17.list',
      'form17.refresh',
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

  it('classifies and discovers vaccination operations as scoped reads', () => {
    const vaccinationOperations = maccabiOperations.filter(
      (operation) => operation.resource === 'vaccinations',
    );
    expect(vaccinationOperations.map(({ name, capability, scope }) => ({ name, capability, scope }))).toEqual([
      { name: 'vaccinations.list', capability: 'read', scope: 'maccabi:vaccinations:read' },
      { name: 'vaccinations.refresh', capability: 'read', scope: 'maccabi:vaccinations:read' },
    ]);

    const grant = new PermissionEngine(policy(['maccabi:vaccinations:read']));
    expect(grant.visibleOperations(maccabiOperations).map((operation) => operation.name)).toEqual([
      'vaccinations.list',
      'vaccinations.refresh',
    ]);
  });

  it('uses stable unqualified and fund-qualified vaccination tool names', () => {
    const list = maccabiOperations.find((operation) => operation.name === 'vaccinations.list')!;
    const refresh = maccabiOperations.find((operation) => operation.name === 'vaccinations.refresh')!;

    expect(toolNameFor(list, false)).toBe('vaccinations_list');
    expect(toolNameFor(refresh, false)).toBe('vaccinations_refresh');
    expect(toolNameFor(list, true)).toBe('maccabi_vaccinations_list');
    expect(toolNameFor(refresh, true)).toBe('maccabi_vaccinations_refresh');
  });

  it('uses stable unqualified and fund-qualified tool names', () => {
    const list = maccabiOperations.find((operation) => operation.name === 'testResults.list')!;
    const refresh = maccabiOperations.find((operation) => operation.name === 'testResults.refresh')!;

    expect(toolNameFor(list, false)).toBe('testResults_list');
    expect(toolNameFor(refresh, false)).toBe('testResults_refresh');
    expect(toolNameFor(list, true)).toBe('maccabi_testResults_list');
    expect(toolNameFor(refresh, true)).toBe('maccabi_testResults_refresh');
  });

  it('classifies and discovers form17 operations as scoped reads', () => {
    const form17Operations = maccabiOperations.filter((operation) => operation.resource === 'form17');
    expect(form17Operations.map(({ name, capability, scope }) => ({ name, capability, scope }))).toEqual([
      { name: 'form17.list', capability: 'read', scope: 'maccabi:form17:read' },
      { name: 'form17.refresh', capability: 'read', scope: 'maccabi:form17:read' },
    ]);

    const grant = new PermissionEngine(policy(['maccabi:form17:read']));
    expect(grant.visibleOperations(maccabiOperations).map((operation) => operation.name)).toEqual([
      'form17.list',
      'form17.refresh',
    ]);
  });

  it('uses stable unqualified and fund-qualified form17 tool names', () => {
    const list = maccabiOperations.find((operation) => operation.name === 'form17.list')!;
    const refresh = maccabiOperations.find((operation) => operation.name === 'form17.refresh')!;

    expect(toolNameFor(list, false)).toBe('form17_list');
    expect(toolNameFor(refresh, false)).toBe('form17_refresh');
    expect(toolNameFor(list, true)).toBe('maccabi_form17_list');
    expect(toolNameFor(refresh, true)).toBe('maccabi_form17_refresh');
  });
});
