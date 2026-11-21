import { DOCTYPES } from '../data/doctypes';
import { db, call } from '@ury/core';

export interface Customer {
  name: string;
  owner: string;
  creation: string;
  modified: string;
  modified_by: string;
  docstatus: number;
  idx: number;
  naming_series: string;
  customer_name: string;
  customer_type: string;
  mobile_number: string;
  customer_group: string;
  territory: string;
  is_internal_customer: number;
  language: string;
  default_commission_rate: number;
  so_required: number;
  dn_required: number;
  is_frozen: number;
  disabled: number;
  doctype: string;
  companies: any[];
  credit_limits: any[];
  accounts: any[];
  sales_team: any[];
  portal_users: any[];
}

export interface CreateCustomerData {
  customer_name: string;
  mobile_number: string;
  customer_group?: string;
  territory?: string;
  name?: string;
}

export interface CreateCustomerResponse {
  data: CreateCustomerData;
  _server_messages?: string;
}


export async function getCustomerGroups() {
  const groups = await db.getDocList(DOCTYPES.CUSTOMER_GROUP, {
    fields: ['name'],
    limit: 0,
    orderBy: {
      field: 'name',
      order: 'asc',
    },
  });
  return groups;
}

export async function getCustomerTerritories() {
  const territories = await db.getDocList(DOCTYPES.CUSTOMER_TERRITORY, {
    fields: ['name'],
    limit: 0,
    orderBy: {
      field: 'name',
      order: 'asc',
    },
  });
  return territories;
}

export async function addCustomer(
  customerData: CreateCustomerData
): Promise<CreateCustomerResponse> {
  try {
    const response = await call.post('ury.ury_pos.api.create_customer', customerData);
    const msg = response.message;
    if (!msg || msg.status !== "success") {
      throw new Error(msg?.message || "Failed to create Customer,API Response error");
    }
    return {
      data: {
        name: msg.name,
        customer_name: msg.customer_name,
        mobile_number: msg.mobile_number,
        customer_group: msg.customer_group,
        territory: msg.territory
      }
    };

  } catch (error) {
    console.error('Error creating customer:', error);
    throw error;
  }
}

function getscramblePattern(text: string) {
  return `%${text.split("").join("%")}%`;
}

// With no search text, the most recently added or changed customers are listed.
// Phones are matched on their digits without leading zeros, so "0712 345"
// finds "+254712345678".
function phonePattern(text: string) {
  const digits = text.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 3 ? `%${digits.split('').join('%')}%` : `%${text}%`;
}

export async function searchCustomers(search: string, limit = 5) {
  const term = search.trim();

  try {
    const res = term
      ? await db.getDocList(DOCTYPES.CUSTOMER, {
          // mobile_number is URY's field; mobile_no is ERPNext's, set for
          // customers created in the Desk.
          fields: ["name", "customer_name", "mobile_number", "mobile_no"],
          filters: [["disabled", "=", 0]],
          orFilters: [
            ["customer_name", "like", getscramblePattern(term)],
            ["mobile_number", "like", phonePattern(term)],
            ["mobile_no", "like", phonePattern(term)],
            ["name", "like", getscramblePattern(term)],
          ],
          limit,
          limit_start: 0,
        })
      : await db.getDocList(DOCTYPES.CUSTOMER, {
          fields: ["name", "customer_name", "mobile_number", "mobile_no"],
          filters: [["disabled", "=", 0]],
          orderBy: { field: "modified", order: "desc" },
          limit: 10,
          limit_start: 0,
        });

    return res.map((doc: any) => ({
      ...doc,
      content: `Customer Name : ${doc.customer_name ?? ""} | Mobile Number : ${doc.mobile_number || doc.mobile_no || ""}`,
    }));
  } catch (error) {
    console.error("Customer search error:", error);
    throw error;
  }
}
