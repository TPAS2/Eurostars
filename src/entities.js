'use strict';

// Declarative definitions for the record types agents manage. The generic CRUD routes
// build their lists, forms, validation and queries from these, always scoped to the
// signed-in account.

const PROPERTY_LABEL = "p.address_line1 || COALESCE(', ' || p.postcode, '')";

const ENTITIES = {
  landlords: {
    table: 'landlords',
    singular: 'Landlord',
    plural: 'Landlords',
    titleField: 'name',
    order: 'name COLLATE NOCASE',
    searchBar: true,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'code', label: 'Landlord code', type: 'text', help: 'Your own reference for this landlord, e.g. LL001.' },
      { name: 'statement_type', label: 'Statement type', type: 'select', options: ['Email', 'Cheque'], required: true, default: 'Email', help: 'Email: their statement is emailed in the rent run. Cheque: their statement is printed and sent with a cheque.' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'address', label: 'Correspondence address', type: 'textarea', inline: true, startRow: true },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true },
    ],
    columns: ['name', 'code', 'statement_type', 'email', 'phone'],
    children: [
      { entity: 'properties', fk: 'landlord_id' },
      { entity: 'transactions', fk: 'landlord_id' },
    ],
  },

  properties: {
    table: 'properties',
    singular: 'Property',
    plural: 'Properties',
    titleField: 'address_line1',
    order: 'address_line1 COLLATE NOCASE',
    searchBar: true,
    fields: [
      { name: 'council_id', label: 'Council', type: 'ref', ref: 'councils', help: 'The local authority for this address.' },
      { name: 'address_line1', label: 'Property name', type: 'text', required: true },
      { name: 'town', label: 'Town / city', type: 'text' },
      { name: 'postcode', label: 'Postcode', type: 'text' },
      { name: 'landlord_id', label: 'Landlord', type: 'ref', ref: 'landlords' },
      { name: 'property_type', label: 'Type', type: 'select', options: ['House', 'Flat', 'HMO', 'Bungalow', 'Studio', 'Commercial', 'Other'] },
      { name: 'bedrooms', label: 'Bedrooms', type: 'integer' },
      { name: 'management_fee_pct', label: 'Management fee %', type: 'number', help: 'Deducted automatically from rent received.' },
      { name: 'council_tax_account', label: 'Council tax account no.', type: 'text' },
      { name: 'council_tax_payer', label: 'Council tax paid by', type: 'select', options: ['Tenant', 'Landlord', 'Agent'] },
      { name: 'status', label: 'Status', type: 'select', options: ['vacant', 'let', 'under offer', 'unavailable'], required: true, default: 'vacant' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['address_line1', 'council_id', 'town', 'landlord_id', 'status'],
    children: [
      { entity: 'tenancies', fk: 'property_id' },
      { entity: 'compliance', fk: 'property_id' },
      { entity: 'maintenance', fk: 'property_id' },
      { entity: 'transactions', fk: 'property_id' },
    ],
  },

  councils: {
    table: 'councils',
    singular: 'Council',
    plural: 'Councils',
    titleField: 'name',
    order: 'name COLLATE NOCASE',
    searchBar: true,
    fields: [
      { name: 'name', label: 'Council', type: 'text', required: true },
      { name: 'council_tax_phone', label: 'Phone number', type: 'tel' },
      { name: 'council_tax_email', label: 'Email', type: 'email' },
      { name: 'website', label: 'Website', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true },
    ],
    columns: ['name', 'properties'],
    // Columns worked out when listing rather than stored on the record.
    computed: { properties: { label: 'Properties' } },
    children: [{ entity: 'properties', fk: 'council_id' }],
  },

  tenants: {
    table: 'tenants',
    singular: 'Tenant',
    plural: 'Tenants',
    titleField: 'name',
    order: 'name COLLATE NOCASE',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['name', 'email', 'phone'],
    children: [{ entity: 'tenancies', fk: 'tenant_id' }],
  },

  tenancies: {
    table: 'tenancies',
    singular: 'Tenancy',
    plural: 'Tenancies',
    order: 'start_date DESC',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true },
      { name: 'tenant_id', label: 'Lead tenant', type: 'ref', ref: 'tenants', required: true },
      { name: 'booking_date', label: 'Booking date', type: 'date', required: true, default: 'today', help: 'When the let was agreed / booked.' },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'rent_pence', label: 'Rent (£)', type: 'money', required: true },
      { name: 'rent_frequency', label: 'Rent frequency', type: 'select', options: ['monthly', 'weekly'], required: true, default: 'monthly' },
      { name: 'deposit_pence', label: 'Deposit (£)', type: 'money' },
      { name: 'deposit_scheme', label: 'Deposit scheme', type: 'select', options: ['DPS', 'TDS', 'mydeposits', 'Held by landlord', 'None'] },
      { name: 'status', label: 'Status', type: 'select', options: ['active', 'pending', 'ended'], required: true, default: 'active' },
    ],
    columns: ['property_id', 'tenant_id', 'booking_date', 'start_date', 'end_date', 'rent_pence', 'status'],
    children: [{ entity: 'transactions', fk: 'tenancy_id' }],
  },

  maintenance: {
    table: 'maintenance_jobs',
    singular: 'Maintenance job',
    plural: 'Maintenance',
    titleField: 'title',
    order: "CASE status WHEN 'completed' THEN 1 ELSE 0 END, reported_date DESC",
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true },
      { name: 'title', label: 'Issue', type: 'text', required: true },
      { name: 'description', label: 'Details', type: 'textarea' },
      { name: 'contractor', label: 'Contractor', type: 'text' },
      { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'emergency'], required: true, default: 'normal' },
      { name: 'status', label: 'Status', type: 'select', options: ['open', 'in progress', 'completed'], required: true, default: 'open' },
      { name: 'reported_date', label: 'Reported', type: 'date', default: 'today' },
      { name: 'cost_pence', label: 'Cost (£)', type: 'money' },
    ],
    columns: ['title', 'property_id', 'priority', 'status', 'reported_date', 'cost_pence'],
  },

  compliance: {
    table: 'compliance_items',
    singular: 'Certificate',
    plural: 'Compliance',
    titleField: 'item_type',
    order: 'expiry_date',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true },
      { name: 'item_type', label: 'Certificate', type: 'select', required: true,
        options: ['Gas Safety (CP12)', 'EICR', 'Insurance', 'EPC', 'Smoke & CO alarms', 'Legionella risk assessment', 'HMO licence', 'Selective licence', 'PAT test', 'Fire risk assessment', 'Other'] },
      { name: 'issued_date', label: 'Issued / start date', type: 'date' },
      { name: 'expiry_date', label: 'Expires', type: 'date', required: true },
      { name: 'provider', label: 'Provider', type: 'text', help: 'Gas engineer, electrician or insurer.' },
      { name: 'reference', label: 'Certificate / policy no.', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['item_type', 'property_id', 'issued_date', 'expiry_date', 'provider'],
  },

  transactions: {
    table: 'transactions',
    singular: 'Transaction',
    plural: 'Transactions',
    order: 'txn_date DESC, id DESC',
    fields: [
      { name: 'txn_date', label: 'Date', type: 'date', required: true, default: 'today' },
      { name: 'txn_type', label: 'Type', type: 'select', required: true,
        options: ['rent_charge', 'rent_received', 'expense', 'landlord_payment', 'fee'],
        optionLabels: { rent_charge: 'Rent due (charge)', rent_received: 'Rent received', expense: 'Expense paid for landlord', landlord_payment: 'Payment to landlord', fee: 'Agency fee' } },
      { name: 'tenancy_id', label: 'Tenancy', type: 'ref', ref: 'tenancies', help: 'For rent charges and receipts.' },
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', help: 'Filled from the tenancy if left blank.' },
      { name: 'landlord_id', label: 'Landlord', type: 'ref', ref: 'landlords', help: 'Filled from the property if left blank.' },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'amount_pence', label: 'Amount (£)', type: 'money', required: true },
    ],
    columns: ['txn_date', 'txn_type', 'description', 'property_id', 'landlord_id', 'amount_pence'],
  },
};

// SQL used to label rows of each entity in dropdowns and tables.
const REF_LABELS = {
  landlords: { from: 'landlords l', label: 'l.name', alias: 'l' },
  properties: { from: 'properties p', label: PROPERTY_LABEL, alias: 'p' },
  tenants: { from: 'tenants t', label: 't.name', alias: 't' },
  councils: { from: 'councils c', label: 'c.name', alias: 'c' },
  tenancies: {
    from: 'tenancies ty JOIN properties p ON p.id = ty.property_id JOIN tenants t ON t.id = ty.tenant_id',
    label: "p.address_line1 || ' — ' || t.name || ' (' || ty.start_date || ')'",
    alias: 'ty',
  },
};

for (const [key, def] of Object.entries(ENTITIES)) {
  def.key = key;
  def.fieldMap = Object.fromEntries(def.fields.map((f) => [f.name, f]));
  for (const [name, c] of Object.entries(def.computed || {})) def.fieldMap[name] = { name, label: c.label, type: 'computed' };
}

module.exports = { ENTITIES, REF_LABELS };
