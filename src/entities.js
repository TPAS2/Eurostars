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
    order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, name COLLATE NOCASE",
    searchBar: true,
    fields: [
      // Two to a row: Name | Landlord code, Address | Statement type, Telephone | Lease date, Email | Overseas.
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'code', label: 'Landlord code', type: 'text', required: true, help: 'Filled in with the next number automatically; change it if you need to.' },
      { name: 'address', label: 'Correspondence address', type: 'textarea', required: true, inline: true },
      { name: 'statement_type', label: 'Statement type', type: 'select', options: ['Email', 'Cheque'], required: true, segment: true },
      { name: 'phone', label: 'Telephone number', type: 'tel', required: true },
      { name: 'date_started', label: 'Lease commencement date', type: 'date', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'overseas', label: 'Overseas landlord', type: 'select', options: ['No', 'Yes'], required: true, segment: true },
      { name: 'bank_name', label: 'Bank name', type: 'text', required: true, suggest: 'banks', startRow: true, help: 'Pick from the list or type a new bank.' },
      { name: 'bank_account_name', label: 'Account name', type: 'text', required: true },
      { name: 'bank_account_number', label: 'Account number', type: 'text', pattern: 'accountnumber', required: true },
      { name: 'bank_sort_code', label: 'Sort code', type: 'text', pattern: 'sortcode', required: true },
      { name: 'payment_note', label: 'Payment terms', type: 'select', options: ['Nightly', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'], required: true, segment: true, help: 'Shown in yellow beside them on the Bank Transfer sheet.' },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true },
    ],
    columns: ['code', 'name', 'statement_type', 'email', 'phone'],
    children: [
      { entity: 'properties', fk: 'landlord_id' },
    ],
  },

  properties: {
    table: 'properties',
    singular: 'Property',
    plural: 'Properties',
    titleField: 'address_line1',
    order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, address_line1 COLLATE NOCASE",
    searchBar: true,
    fields: [
      // Laid out on a 12-column grid (span = columns): address, town, postcode, code; council, landlord,
      // type, bedrooms, bathrooms, parking; the four rents; status and fee; the three dates; notes.
      { name: 'address_line1', label: 'Property address', type: 'text', required: true, span: 4 },
      { name: 'town', label: 'Town / city', type: 'text', span: 3 },
      { name: 'postcode', label: 'Postcode', type: 'text', span: 2 },
      { name: 'code', label: 'Property code', type: 'text', required: true, span: 3, help: 'Next number filled in for you.' },
      { name: 'council_id', label: 'Council', type: 'ref', ref: 'councils', span: 2, startRow: true },
      { name: 'landlord_id', label: 'Landlord', type: 'ref', ref: 'landlords', search: true, span: 2, help: 'Type a name or landlord code, then pick from the list.' },
      { name: 'property_type', label: 'Type', type: 'select', span: 2, options: ['House', 'Flat', 'Maisonette', 'HMO', 'Bungalow', 'Studio', 'Commercial', 'Other'] },
      { name: 'bedrooms', label: 'Bedrooms', type: 'integer', span: 2 },
      { name: 'bathrooms', label: 'Bathrooms', type: 'integer', span: 2 },
      { name: 'parking', label: 'Parking', type: 'select', span: 2, options: ['None', 'Street', 'Permit', 'Driveway', 'Allocated space', 'Garage'] },
      { name: 'rent_pence', label: 'Rent from council (£ per month)', type: 'money', span: 3, startRow: true, help: 'Charged on the Rent run.' },
      { name: 'tenant_rent_pence', label: 'Rent from tenant (£ per month)', type: 'money', span: 3, help: 'Only if the person staying pays rent.' },
      { name: 'landlord_rent_pence', label: 'Rent to landlord (£ per month)', type: 'money', span: 3, help: 'Paid monthly, even if rent hasn’t come in.' },
      { name: 'price_per_night_pence', label: 'Price per night (£)', type: 'money', span: 3, help: 'For short stays.' },
      { name: 'status', label: 'Status', type: 'select', span: 3, options: ['vacant', 'let', 'managed', 'under offer', 'unavailable', 'handed back'], required: true, default: 'vacant', startRow: true },
      { name: 'management_fee_pct', label: 'Management fee %', type: 'number', span: 3, help: 'Taken from the rent.' },
      { name: 'acquired_date', label: 'Date acquired', type: 'date', span: 4, default: 'today', startRow: true },
      { name: 'lease_start_date', label: 'Lease start with landlord', type: 'date', span: 4 },
      { name: 'handed_back_date', label: 'Date handed back', type: 'date', span: 4, help: 'Sets the status to handed back.' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    // The property page's info box keeps Council near the top (the form has it beside Status).
    detailsOrder: ['council_id', 'code', 'address_line1', 'town', 'postcode', 'landlord_id', 'property_type', 'bedrooms', 'bathrooms', 'parking', 'rent_pence', 'tenant_rent_pence', 'price_per_night_pence', 'landlord_rent_pence', 'management_fee_pct', 'status', 'lease_start_date', 'acquired_date', 'handed_back_date', 'notes'],
    columns: ['code', 'address_line1', 'council_id', 'landlord_id', 'cur_tenant', 'status'],
    computed: { cur_tenant: { label: 'Tenant' } },
    children: [
      { entity: 'tenancies', fk: 'property_id' },
      { entity: 'maintenance', fk: 'property_id' },
      { entity: 'inspections', fk: 'property_id' },
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
    computed: { properties: { label: 'Properties With Council' }, database: { label: 'Database' } },
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
      { name: 'council_ref', label: 'Council reference number', type: 'text', help: 'The council’s own reference for this tenant.' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    columns: ['cur_tenancy_no', 'name', 'cur_property', 'cur_term', 'cur_status', 'cur_council', 'council_ref'],
    computed: {
      cur_tenancy_no: { label: 'Tenancy no.' }, cur_property: { label: 'Property' }, cur_council: { label: 'Council' },
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
      { name: 'tenancy_no', label: 'Tenancy no.', type: 'text', auto: true },
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true },
      { name: 'tenant_id', label: 'Lead tenant', type: 'ref', ref: 'tenants', required: true },
      { name: 'booking_date', label: 'Reservation date', type: 'date', required: true, default: 'today', help: 'When the tenant reserved the property.' },
      { name: 'term_booked', label: 'Term as booked', type: 'text', help: 'How long it was booked for, e.g. 6 months or 28 nights.' },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date', help: 'Once this date comes, the tenancy is marked Ended.' },
      { name: 'status', label: 'Status', type: 'select', options: ['active', 'pending', 'ended'], required: true, default: 'active' },
      { name: 'paid_by', label: 'Rent paid by', type: 'select', options: ['Council', 'Tenant'], required: true, default: 'Council', help: 'Who pays the rent. Only council-paid tenancies count in Council Reconciliation.' },
      { name: 'rent_pence', label: 'Rent amount (£ per month)', type: 'money', help: 'Leave blank to use the property’s Rent from council (or Rent from tenant if the tenant pays).' },
    ],
    columns: ['tenancy_no', 'property_id', 'tenant_id', 'booking_date', 'term_booked', 'start_date', 'end_date', 'status', 'paid_by', 'rent_pence'],
    children: [{ entity: 'transactions', fk: 'tenancy_id' }],
  },

  contractors: {
    table: 'contractors',
    singular: 'Contractor',
    plural: 'Contractors',
    titleField: 'name',
    order: "CASE WHEN code IS NULL OR code = '' THEN 1 ELSE 0 END, code COLLATE NOCASE, name COLLATE NOCASE",
    searchBar: true,
    fields: [
      // Laid out three to a row: Name, Trade, Contractor code; Phone, Email; Address beside Notes.
      { name: 'name', label: 'Name', type: 'text', required: true, help: 'Invoices from this supplier are matched by name.' },
      { name: 'trade', label: 'Trade', type: 'text', help: 'e.g. Plumber, Electrician, Roofer.' },
      { name: 'code', label: 'Contractor code', type: 'text', help: 'Filled in with the next number automatically; shown on job sheets.' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'address', label: 'Address', type: 'textarea', inline: true, startRow: true },
      { name: 'notes', label: 'Notes', type: 'textarea', inline: true, span: 2 },
    ],
    columns: ['name', 'code', 'trade', 'phone', 'invoice_count', 'total_paid', 'unpaid'],
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
      { name: 'preferred_start_date', label: 'Preferred start date', type: 'date' },
      { name: 'estimate_required', label: 'Estimate required', type: 'select', options: ['No', 'Yes'], default: 'No' },
      { name: 'go_ahead', label: 'Go ahead?', type: 'select', options: ['No', 'Yes'], default: 'No' },
      { name: 'contractor_code', label: 'Contractor code', type: 'text' },
      { name: 'contractor_phone', label: 'Contractor phone', type: 'tel' },
      { name: 'contractor_mobile', label: 'Contractor mobile', type: 'tel' },
      { name: 'contractor_fax', label: 'Contractor fax', type: 'tel' },
      { name: 'contractor_email', label: 'Contractor email', type: 'email' },
      { name: 'billing_name', label: 'Billing name', type: 'text' },
      { name: 'added_by', label: 'Added by', type: 'person', locked: true },
    ],
    files: true,
    columns: ['title', 'property_id', 'priority', 'status', 'reported_date', 'cost_pence', 'added_by'],
  },

  inspections: {
    table: 'inspections',
    singular: 'Inspection',
    plural: 'Inspections',
    titleField: 'inspection_type',
    order: 'inspection_date DESC, id DESC',
    fields: [
      { name: 'property_id', label: 'Property', type: 'ref', ref: 'properties', required: true },
      { name: 'inspection_date', label: 'Date of inspection', type: 'date', required: true, default: 'today' },
      { name: 'inspection_type', label: 'Type', type: 'select', options: ['Routine', 'Check-in', 'Check-out', 'Mid-term', 'Other'], required: true, default: 'Routine' },
      { name: 'condition', label: 'Condition', type: 'select', options: ['Good', 'Fair', 'Poor'] },
      { name: 'inspected_by', label: 'Inspected by', type: 'person', required: true },
      { name: 'checklist', label: 'Safety requirements', type: 'checklist', wide: true },
      { name: 'notes', label: 'Notes', type: 'textarea', help: 'What was found, and anything that needs doing.' },
    ],
    columns: ['inspection_date', 'inspection_type', 'property_id', 'condition', 'inspected_by'],
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
        options: ['rent_charge', 'rent_received', 'landlord_rent', 'expense', 'landlord_payment', 'fee'],
        optionLabels: { rent_charge: 'Rent due (charge)', rent_received: 'Rent received', landlord_rent: 'Rent due to landlord (fixed monthly)', expense: 'Expense paid for landlord', landlord_payment: 'Payment to landlord', fee: 'Agency fee' } },
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
  landlords: { from: 'landlords l', label: 'l.name', alias: 'l', hint: "COALESCE(l.code, '')" },
  properties: { from: 'properties p', label: PROPERTY_LABEL, alias: 'p', hint: "COALESCE(p.code, '')" },
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
