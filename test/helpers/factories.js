import { query } from '../../src/db/pool.js';
import { hashPassword } from '../../src/services/auth.js';

export const DEFAULT_TEST_PASSWORD = 'Test!23456';

/**
 * Insert a user with a real Argon2id hash, so login tests exercise the same
 * password path as production instead of mocking verification.
 * @param {{
 *   email: string,
 *   password?: string,
 *   fullName?: string,
 *   role?: 'admin' | 'storekeeper' | 'analyst',
 *   phone?: string | null,
 *   isActive?: boolean,
 * }} overrides
 * @returns {Promise<{
 *   id: number,
 *   email: string,
 *   full_name: string,
 *   role: string,
 *   phone: string | null,
 *   is_active: boolean,
 * }>}
 */
export async function createUserFactory(overrides) {
  const {
    email,
    password = DEFAULT_TEST_PASSWORD,
    fullName = 'Тестовый сотрудник',
    role = 'storekeeper',
    phone = null,
    isActive = true,
  } = overrides;

  if (!email) throw new TypeError('createUserFactory: email is required');

  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `insert into users (email, password_hash, full_name, role, phone, is_active)
     values ($1, $2, $3, $4, $5, $6)
     returning id, email, full_name, role, phone, is_active`,
    [email, passwordHash, fullName, role, phone, isActive],
  );

  return rows[0];
}

/**
 * Insert a warehouse. Defaults describe the Minsk central warehouse, so a test
 * that needs a second one must pass a distinct `code`.
 * @param {{
 *   code?: string,
 *   name?: string,
 *   city?: string,
 *   address?: string,
 *   isActive?: boolean,
 * }} [overrides]
 * @returns {Promise<{ id: number, code: string, name: string, is_active: boolean }>}
 */
export async function createWarehouseFactory(overrides = {}) {
  const {
    code = 'WH-TST',
    name = 'Тестовый склад',
    city = 'Минск',
    address = 'ул. Купревича, 1/2',
    isActive = true,
  } = overrides;

  const { rows } = await query(
    `insert into warehouses (code, name, city, address, is_active)
     values ($1, $2, $3, $4, $5)
     returning id, code, name, is_active`,
    [code, name, city, address, isActive],
  );

  return rows[0];
}

/**
 * Insert a supplier. `unp` is unique, so every supplier in one test needs its
 * own nine-digit number.
 * @param {{
 *   name?: string,
 *   unp?: string,
 *   leadTimeDays?: number,
 *   phone?: string | null,
 *   email?: string | null,
 *   address?: string | null,
 *   isActive?: boolean,
 * }} [overrides]
 * @returns {Promise<{ id: number, name: string, is_active: boolean }>}
 */
export async function createSupplierFactory(overrides = {}) {
  const {
    name = 'ООО «ТестПоставка»',
    unp = '190000001',
    leadTimeDays = 5,
    phone = '+375 (17) 200-00-00',
    email = 'sales@testpostavka.by',
    address = 'г. Минск, пр-т Независимости, 1',
    isActive = true,
  } = overrides;

  const { rows } = await query(
    `insert into suppliers (name, unp, lead_time_days, phone, email, address, is_active)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, name, is_active`,
    [name, unp, leadTimeDays, phone, email, address, isActive],
  );

  return rows[0];
}

/**
 * Insert a component. Prices stay strings because the columns are `numeric` and
 * the application never lets a float touch money.
 * @param {{
 *   sku?: string,
 *   name?: string,
 *   categoryId: number,
 *   manufacturerId: number,
 *   supplierId: number,
 *   purchasePrice?: string,
 *   retailPrice?: string,
 *   minStock?: number,
 *   maxStock?: number | null,
 *   isActive?: boolean,
 * }} overrides
 * @returns {Promise<{ id: number, sku: string, name: string, is_active: boolean }>}
 */
export async function createComponentFactory(overrides) {
  const {
    sku = 'CPU-TEST-01',
    name = 'Процессор тестовый',
    categoryId,
    manufacturerId,
    supplierId,
    purchasePrice = '100.00',
    retailPrice = '150.00',
    minStock = 0,
    maxStock = null,
    isActive = true,
  } = overrides;

  const { rows } = await query(
    `insert into components
       (sku, name, category_id, manufacturer_id, default_supplier_id,
        purchase_price, retail_price, min_stock, max_stock, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id, sku, name, is_active`,
    [
      sku,
      name,
      categoryId,
      manufacturerId,
      supplierId,
      purchasePrice,
      retailPrice,
      minStock,
      maxStock,
      isActive,
    ],
  );

  return rows[0];
}

/**
 * Seed the minimal reference data a stock document needs: an author, one
 * warehouse, one supplier and one component. `receiptInput` is a ready-to-use
 * `postReceipt` payload; individual ids are returned for tests that archive an
 * entity or assert on the written rows.
 * @param {{
 *   warehouseCode?: string,
 *   componentSku?: string,
 *   docDate?: string,
 *   comment?: string | null,
 * }} [overrides]
 */
export async function seedBase(overrides = {}) {
  const {
    warehouseCode = 'WH-TST',
    componentSku = 'CPU-TEST-01',
    docDate = '2026-11-22',
    comment = 'Тестовая приёмка',
  } = overrides;

  const user = await createUserFactory({ email: 'sklad@test.by', role: 'storekeeper' });
  const warehouse = await createWarehouseFactory({ code: warehouseCode });
  const supplier = await createSupplierFactory();

  const { rows: categoryRows } = await query(
    `insert into categories (name, slug) values ('Комплектующие', 'komplektuyushchie') returning id`,
  );
  const { rows: manufacturerRows } = await query(
    `insert into manufacturers (name, country) values ('ТехноКорп', 'Беларусь') returning id`,
  );
  const categoryId = categoryRows[0].id;
  const manufacturerId = manufacturerRows[0].id;

  const component = await createComponentFactory({
    sku: componentSku,
    categoryId,
    manufacturerId,
    supplierId: supplier.id,
  });

  return {
    userId: user.id,
    warehouseId: warehouse.id,
    supplierId: supplier.id,
    componentId: component.id,
    categoryId,
    manufacturerId,
    docDate,
    receiptInput: {
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      docDate,
      comment,
      userId: user.id,
      lines: [{ componentId: component.id, qty: 1, unitCost: '100.0000' }],
    },
  };
}
