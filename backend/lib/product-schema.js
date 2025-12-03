const attributeEntrySchema = {
  type: 'object',
  required: ['key', 'value', 'value_type'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', minLength: 1 },
    value: {
      anyOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'null' },
      ],
    },
    value_type: {
      type: 'string',
      enum: ['string', 'number', 'boolean'],
    },
  },
};

const productImageSchema = {
  type: 'object',
  required: ['source', 'variant', 'url_or_base64', 'notes'],
  additionalProperties: false,
  properties: {
    source: {
      type: 'string',
      enum: ['upload', 'generated', 'web'],
    },
    variant: {
      type: ['string', 'null'],
      enum: ['front', 'angle', 'detail', 'pack', 'other', null],
    },
    url_or_base64: { type: 'string', minLength: 1 },
    notes: { type: ['string', 'null'] },
  },
};

const priceSourceSchema = {
  type: 'object',
  required: ['name', 'url', 'price', 'shipping', 'checked_at'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    url: { type: 'string', minLength: 1 },
    price: { type: ['number', 'null'] },
    shipping: { type: ['number', 'null'] },
    checked_at: { type: ['string', 'null'] },
  },
};

const productSchema = {
  type: 'object',
  required: ['id', 'identification', 'details', 'ops', 'notes'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    identification: {
      type: 'object',
      required: ['method', 'barcodes', 'name', 'brand', 'category', 'confidence'],
      additionalProperties: false,
      properties: {
        method: { type: 'string', enum: ['image', 'barcode', 'hybrid'] },
        barcodes: {
          type: 'array',
          items: { type: 'string', minLength: 3 },
        },
        name: { type: 'string', minLength: 1 },
        brand: { type: 'string', minLength: 1 },
        category: { type: 'string', minLength: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    details: {
      type: 'object',
      required: ['short_description', 'key_features', 'attributes', 'identifiers', 'images', 'pricing'],
      additionalProperties: false,
      properties: {
        short_description: { type: 'string', minLength: 1 },
        key_features: {
          type: 'array',
          minItems: 3,
          items: { type: 'string', minLength: 2 },
        },
        attributes: {
          type: 'array',
          items: attributeEntrySchema,
        },
        identifiers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ean: { type: ['string', 'null'] },
            gtin: { type: ['string', 'null'] },
            upc: { type: ['string', 'null'] },
            mpn: { type: ['string', 'null'] },
            sku: { type: ['string', 'null'] },
          },
          required: ['ean', 'gtin', 'upc', 'mpn', 'sku'],
        },
        images: {
          type: 'array',
          items: productImageSchema,
        },
        pricing: {
          type: 'object',
          required: ['lowest_price', 'price_confidence'],
          additionalProperties: false,
          properties: {
            lowest_price: {
              type: 'object',
              required: ['amount', 'currency', 'sources', 'last_checked_iso'],
              additionalProperties: false,
              properties: {
                amount: { type: 'number', minimum: 0 },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
                sources: {
                  type: 'array',
                  minItems: 1,
                  items: priceSourceSchema,
                },
                last_checked_iso: { type: ['string', 'null'] },
              },
            },
            price_confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
    ops: {
      type: 'object',
      required: ['sync_status', 'last_saved_iso', 'last_synced_iso', 'revision'],
      additionalProperties: false,
      properties: {
        sync_status: { type: 'string', enum: ['pending', 'synced', 'failed'] },
        last_saved_iso: { type: ['string', 'null'] },
        last_synced_iso: { type: ['string', 'null'] },
        revision: { type: 'integer', minimum: 0 },
      },
    },
    notes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unsure: {
          type: 'array',
          items: { type: 'string' },
        },
        warnings: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['unsure', 'warnings'],
    },
  },
};

const productBundleSchema = {
  type: 'object',
  required: ['products', 'rendering'],
  additionalProperties: false,
  properties: {
    products: {
      type: 'array',
      minItems: 1,
      items: productSchema,
    },
    rendering: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string' },
        datasheet_page: { type: 'string' },
        admin_table_page: { type: 'string' },
      },
      required: ['format', 'datasheet_page', 'admin_table_page'],
    },
  },
};

module.exports = {
  productBundleSchema,
};

