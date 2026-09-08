// Contract service line / billed unit tool surface tests:
// autotask_search_contract_services, autotask_search_contract_service_units,
// autotask_search_contract_service_bundles, autotask_search_contract_service_bundle_units,
// and the autotask_get_contract_recurring_lines roll-up.
//
// The periodType picklist used below is the live Services.periodType picklist
// (2 Monthly, 3 Quarterly, 4 Semi-Annual, 5 Yearly) — these are the only four
// values Autotask defines, so monthly normalization must resolve all of them
// and leave unresolvedPeriodTypes empty.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code'
  }
};

const mockLogger = new Logger('error');

const findTool = (name: string) => TOOL_DEFINITIONS.find(t => t.name === name);

const NEW_TOOLS = [
  'autotask_search_contract_services',
  'autotask_search_contract_service_units',
  'autotask_search_contract_service_bundles',
  'autotask_search_contract_service_bundle_units',
  'autotask_get_contract_recurring_lines',
];

const PERIOD_TYPE_FIELD = {
  name: 'periodType',
  dataType: 'integer',
  isRequired: true,
  isReadOnly: true,
  isQueryable: true,
  isReference: false,
  isPickList: true,
  picklistValues: [
    { value: '2', label: 'Monthly' },
    { value: '3', label: 'Quarterly' },
    { value: '4', label: 'Semi-Annual' },
    { value: '5', label: 'Yearly' },
  ],
};

describe('contract service line tool definitions', () => {
  test.each(NEW_TOOLS)('%s is defined and requires contractID', (name) => {
    const tool = findTool(name);
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, any>;
    expect(props.contractID.type).toBe('number');
    expect(tool!.inputSchema.required).toEqual(['contractID']);
  });

  test.each(NEW_TOOLS)('%s is listed in the financial category', (name) => {
    expect(TOOL_CATEGORIES.financial.tools).toContain(name);
  });

  test('unit tools expose an optional activeOn date', () => {
    for (const name of ['autotask_search_contract_service_units', 'autotask_search_contract_service_bundle_units']) {
      const props = findTool(name)!.inputSchema.properties as Record<string, any>;
      expect(props.activeOn.type).toBe('string');
    }
  });

  test('all five tools are read-only — no create/update/delete verbs', () => {
    for (const name of NEW_TOOLS) {
      expect(name).not.toMatch(/_(create|update|delete)_/);
    }
  });
});

describe('contract service line handlers', () => {
  test('autotask_search_contract_services forwards contractID and pageSize', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'searchContractServices').mockResolvedValue([{ id: 1 }] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    const result = await handler.callTool('autotask_search_contract_services', { contractID: 29747643, pageSize: 50 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ contractID: 29747643, pageSize: 50 }));
    expect(result.isError).toBeFalsy();
  });

  test('autotask_search_contract_service_units forwards activeOn', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue([{ id: 1 }] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    await handler.callTool('autotask_search_contract_service_units', { contractID: 7, activeOn: '2026-09-08' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7, activeOn: '2026-09-08' }));
  });

  test('autotask_search_contract_service_bundles and _bundle_units forward to their service methods', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const bundles = jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    const units = jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    const handler = new AutotaskToolHandler(service, mockLogger);
    await handler.callTool('autotask_search_contract_service_bundles', { contractID: 7 });
    await handler.callTool('autotask_search_contract_service_bundle_units', { contractID: 7, activeOn: '2026-09-08' });
    expect(bundles).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7 }));
    expect(units).toHaveBeenCalledWith(expect.objectContaining({ contractID: 7, activeOn: '2026-09-08' }));
  });
});

describe('searchContractServiceUnits date filtering', () => {
  test('activeOn becomes startDate lte / endDate gte filters on the given day', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query });

    await service.searchContractServiceUnits({ contractID: 29747643, activeOn: '2026-09-08' });

    const [entity, filters] = query.mock.calls[0];
    expect(entity).toBe('ContractServiceUnits');
    expect(filters).toEqual([
      { op: 'eq', field: 'contractID', value: 29747643 },
      { op: 'lte', field: 'startDate', value: '2026-09-08T23:59:59' },
      { op: 'gte', field: 'endDate', value: '2026-09-08T00:00:00' },
    ]);
  });

  test('pageSize is capped at 500', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(service as any, 'ensureClient').mockResolvedValue({ query });

    await service.searchContractServiceUnits({ contractID: 1, activeOn: '2026-09-08', pageSize: 5000 });

    expect(query.mock.calls[0][2]).toEqual({ maxRecords: 500 });
  });
});

describe('getContractRecurringLines roll-up', () => {
  const buildService = (overrides: Record<string, any> = {}) => {
    const service = new AutotaskService(mockConfig, mockLogger);
    jest.spyOn(service, 'getContract').mockResolvedValue({
      id: 29747643, contractName: 'AIC - Cloud Services', companyID: 29746549,
    } as any);
    jest.spyOn(service, 'getFieldInfo').mockResolvedValue([PERIOD_TYPE_FIELD] as any);
    jest.spyOn(service, 'getCompany').mockImplementation(async (id: number) => (
      id === 29746549
        ? { id, companyName: 'Advanced Industrial Coatings (AIC)' } as any
        : { id, companyName: 'Microsoft' } as any
    ));
    jest.spyOn(service, 'searchContractServiceBundles').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServiceBundleUnits').mockResolvedValue([] as any);
    jest.spyOn(service, 'searchContractServices').mockResolvedValue(overrides.serviceLines ?? [] as any);
    jest.spyOn(service, 'searchContractServiceUnits').mockResolvedValue(overrides.serviceUnits ?? [] as any);
    jest.spyOn(service, 'getService').mockImplementation(async (id: number) => overrides.catalog?.[id] ?? null);
    jest.spyOn(service, 'getServiceBundle').mockResolvedValue(null as any);
    return service;
  };

  test('joins units to the catalog and reports name, vendor and monthly total', async () => {
    const service = buildService({
      serviceLines: [{ id: 900, contractID: 29747643, serviceID: 500, unitPrice: 22 }],
      serviceUnits: [{
        id: 1, contractID: 29747643, contractServiceID: 900, serviceID: 500,
        units: 11, price: 22, cost: 18, startDate: '2026-09-01', endDate: '2026-09-30',
      }],
      catalog: { 500: { id: 500, name: 'Microsoft 365 Business Premium - A|M', periodType: 2, vendorCompanyID: 111, unitPrice: 22, unitCost: 18 } },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.contractName).toBe('AIC - Cloud Services');
    expect(result.companyName).toBe('Advanced Industrial Coatings (AIC)');
    expect(result.activeOn).toBe('2026-09-08');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toEqual(expect.objectContaining({
      source: 'service',
      name: 'Microsoft 365 Business Premium - A|M',
      vendorName: 'Microsoft',
      periodLabel: 'Monthly',
      units: 11,
      unitPrice: 22,
      periodTotal: 242,
      monthlyTotal: 242,
    }));
    expect(result.monthlyTotal).toBe(242);
    expect(result.unresolvedPeriodTypes).toEqual([]);
  });

  test('normalizes every live periodType to a monthly figure with none unresolved', async () => {
    const service = buildService({
      serviceLines: [
        { id: 1, serviceID: 2, unitPrice: 120 },
        { id: 2, serviceID: 3, unitPrice: 120 },
        { id: 3, serviceID: 4, unitPrice: 120 },
        { id: 4, serviceID: 5, unitPrice: 120 },
      ],
      serviceUnits: [
        { id: 11, contractServiceID: 1, serviceID: 2, units: 1, price: 120 },
        { id: 12, contractServiceID: 2, serviceID: 3, units: 1, price: 120 },
        { id: 13, contractServiceID: 3, serviceID: 4, units: 1, price: 120 },
        { id: 14, contractServiceID: 4, serviceID: 5, units: 1, price: 120 },
      ],
      catalog: {
        2: { id: 2, name: 'Monthly svc', periodType: 2 },
        3: { id: 3, name: 'Quarterly svc', periodType: 3 },
        4: { id: 4, name: 'Semi-Annual svc', periodType: 4 },
        5: { id: 5, name: 'Yearly svc', periodType: 5 },
      },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });
    const byName = Object.fromEntries(result.lines.map(l => [l.name, l.monthlyTotal]));

    expect(byName['Monthly svc']).toBe(120);
    expect(byName['Quarterly svc']).toBe(40);
    expect(byName['Semi-Annual svc']).toBe(20);
    expect(byName['Yearly svc']).toBe(10);
    expect(result.unresolvedPeriodTypes).toEqual([]);
    expect(result.monthlyTotal).toBe(190);
  });

  test('a periodType missing from the picklist is reported, not guessed silently', async () => {
    const service = buildService({
      serviceLines: [{ id: 1, serviceID: 9, unitPrice: 50 }],
      serviceUnits: [{ id: 11, contractServiceID: 1, serviceID: 9, units: 2, price: 50 }],
      catalog: { 9: { id: 9, name: 'Odd period svc', periodType: 99 } },
    });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.unresolvedPeriodTypes).toEqual([99]);
    expect(result.lines[0].periodTotal).toBe(100);
  });

  test('a contract with no active units returns an empty lines array, not an error', async () => {
    const service = buildService({ serviceLines: [], serviceUnits: [] });

    const result = await service.getContractRecurringLines({ contractID: 29747643, activeOn: '2026-09-08' });

    expect(result.lines).toEqual([]);
    expect(result.monthlyTotal).toBe(0);
    expect(result.unresolvedPeriodTypes).toEqual([]);
  });

  test('defaults activeOn to today when omitted', async () => {
    const service = buildService({ serviceLines: [], serviceUnits: [] });

    const result = await service.getContractRecurringLines({ contractID: 29747643 });

    expect(result.activeOn).toBe(new Date().toISOString().slice(0, 10));
  });
});
