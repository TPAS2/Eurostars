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
      { name: 'name', label: 'Name', type: 'text', required: true, wide: true },
      { name: 'address', label: 'Correspondence address', type: 'textarea', required: true },
      { name: 'phone', label: 'Telephone number', type: 'tel', required: true, wide: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'code', label: 'Landlord code', type: 'text', required: true, help: 'Filled in with the next number automatically; change it if you need to.' },
      { name: 'date_started', label: 'Lease commencement date', type: 'date', default: 'today', required: true },
      { name: 'statement_type', label: 'Statement type', type: 'select', options: ['Email', 'Cheque'], required: true, default: 'Email', help: 'Email: their statement is emailed in the rent run. Cheque: their statement is printed and sent with a cheque.' },
      { name: 'overseas', label: 'Overseas landlord', type: 'select', options: ['No', 'Yes'], required: true, default: 'No' },
      { name: 'bank_name', label: 'Bank name', type: 'text', required: true, suggest: 'banks', startRow: true, help: 'Pick from the list or type a new bank.' },
      { name: 'bank_account_name', label: 'Account name', type: 'text', required: true },
      { name: 'bank_account_number', label: 'Account number', type: 'text', pattern: 'accountnumber', required: true },
      { name: 'bank_sort_code', label: 'Sort code', type: 'text', pattern: 'sortcode', required: true },
      { name: 'payment_note', label: 'Payment terms', type: 'select', options: ['Weekly', 'Monthly', 'Quarterly', 'Yearly'], required: true, default: 'Monthly', help: 'Shown in yellow beside them on the Bank Transfer sheet.' },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true },
    ],
    columns: ['name', 'code', 'statement_type', 'email', 'phone', 'councils'],
    computed: { councils: { label: 'Councils' } },
    children: [
      { entity: 'properties', fk: 'landlord_id' },
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
      { name: 'status', label: 'Status', type: 'select', options: ['vacant', 'let', 'under offer', 'unavailable', 'handed back'], required: true, default: 'vacant' },
      { name: 'acquired_date', label: 'Date acquired', type: 'date', default: 'today', help: 'When you took the property on.', startRow: true },
      { name: 'handed_back_date', label: 'Date handed back', type: 'date', help: 'When it went back to the landlord. Filling this in sets the status to handed back.' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['address_line1', 'council_id', 'landlord_id', 'cur_tenant', 'status'],
    computed: { cur_tenant: { label: 'Tenant' } },
    children: [
      { entity: 'tenancies', fk: 'property_id' },
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
      { name: 'council_tax_phone', label: 'Phone number', type: 'textarea', multi: 'tel', inline: true, help: 'Add as many as you need, one per line.' },
      { name: 'council_tax_email', label: 'Email', type: 'textarea', multi: 'email', inline: true, help: 'Add as many as you need, one per line.' },
      { name: 'website', label: 'Website', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true },
    ],
    columns: ['name', 'properties', 'council_tax_email', 'council_tax_phone', 'database'],
    // Columns worked out when listing rather than stored on the record.
    computed: { properties: { label: 'Properties With This Council' }, database: { label: 'Database' } },
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
    columns: ['name', 'cur_property', 'cur_rent', 'cur_term', 'cur_status', 'phone', 'cur_council'],
    computed: {
      cur_property: { label: 'Property' }, cur_council: { label: 'Council' }, cur_rent: { label: 'Rent' },
      cur_term: { label: 'Tenancy' }, cur_status: { label: 'Status' },
    },
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
      { name: 'status', label: 'Status', type: 'select', options: ['active', 'pending', 'ended'], required: true, default: 'active' },
    ],
    columns: ['property_id', 'tenant_id', 'booking_date', 'start_date', 'end_date', 'rent_pence', 'status'],
    children: [{ entity: 'transactions', fk: 'tenancy_id' }],
  },

  contractors: {
    table: 'contractors',
    singular: 'Contractor',
    plural: 'Contractors',
    titleField: 'name',
    order: 'name COLLATE NOCASE',
    searchBar: true,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, help: 'Invoices from this supplier are matched by name.' },
      { name: 'trade', label: 'Trade', type: 'text', help: 'e.g. Plumber, Electrician, Roofer.' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['name', 'trade', 'phone', 'invoice_count', 'total_paid', 'unpaid'],
    computed: { invoice_count: { label: 'Invoices' }, total_paid: { label: 'Total paid' }, unpaid: { label: 'Unpaid' } },
  },

  maintenance: {
    table: 'maintenance_jobs',
    singular: 'Maintenance job',
    plural: 'Maintenance',
    titleField: 'title',
    order: "CASE status WHEN 'completed' THEN 1 ELSE 0 END, reported_date DESC",
    fields: [
      { name: 'property_id', label: 'Property address', type: 'ref', ref: 'properties', required: true },
      { name: 'title', label: 'Issue', type: 'text', required: true },
      // Description then cost sit beside the issue.
      { name: 'description', label: 'Description of work', type: 'textarea', inline: true },
      { name: 'cost_pence', label: 'Cost (£)', type: 'money' },
      { name: 'contractor', label: 'Contractor', type: 'text', suggest: 'contractors', help: 'Pick from your contractors, or type a new name.' },
      { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'emergency'], required: true, default: 'normal' },
      { name: 'status', label: 'Status', type: 'select', options: ['open', 'in progress', 'completed'], required: true, default: 'open' },
      { name: 'reported_date', label: 'Reported', type: 'date', default: 'today' },
      { name: 'completed_date', label: 'Date completed', type: 'date', help: 'Filled in with today\'s date when the job is saved as completed.' },
      { name: 'added_by', label: 'Added by', type: 'person', required: true },
    ],
    files: true,
    columns: ['title', 'property_id', 'priority', 'status', 'reported_date', 'cost_pence', 'added_by'],
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
  for (const [name, c] of Object.entries(def.computed || {})) def.fieldMap[name] = { name, label: c.label, type: 'computed', num: !!c.num };
}

module.exports = { ENTITIES, REF_LABELS };
