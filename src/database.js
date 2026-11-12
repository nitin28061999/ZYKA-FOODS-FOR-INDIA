const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'orders.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer TEXT NOT NULL, items TEXT NOT NULL,
    status TEXT NOT NULL, eta TEXT NOT NULL, total REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    description TEXT NOT NULL, price REAL NOT NULL, tags TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
  CREATE TABLE IF NOT EXISTS faq_documents (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    embedding_json TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS faq_embedding_model_idx ON faq_documents(embedding_model);
`);

const seedOrder = db.prepare('INSERT OR IGNORE INTO orders VALUES (?, ?, ?, ?, ?, ?)');
seedOrder.run('ZY-2048', 'Demo Customer', '1 × Paneer Tikka Bowl', 'Preparing', '25–35 minutes', 289);
seedOrder.run('ZY-2049', 'Demo Customer', '2 × Masala Dosa', 'Out for delivery', '8–12 minutes', 318);
const seedProduct = db.prepare('INSERT OR IGNORE INTO products VALUES (?, ?, ?, ?, ?, ?)');
[
  ['P1', 'Paneer Tikka Bowl', 'North Indian', 'Smoky paneer, rice, mint chutney and crunchy salad.', 289, 'paneer spicy filling vegetarian protein'],
  ['P2', 'Masala Dosa', 'South Indian', 'Crisp rice crepe with spiced potato, sambar and chutneys.', 159, 'dosa crispy south indian vegetarian mild'],
  ['P3', 'Chole Kulche', 'North Indian', 'Tangy chickpea curry with soft kulche and pickled onions.', 219, 'chickpea spicy north indian filling vegetarian'],
  ['P4', 'Veg Hakka Noodles', 'Indo-Chinese', 'Wok-tossed noodles with seasonal vegetables.', 249, 'noodles chinese savory vegetarian quick'],
  ['P5', 'Mango Lassi', 'Drinks', 'Chilled yogurt blended with ripe mango.', 99, 'drink sweet mango cooling dessert'],
  ['P6', 'Classic Chicken Biryani', 'Biryani', 'Fragrant basmati rice with slow-cooked chicken and raita.', 349, 'chicken biryani spicy rice nonvegetarian']
].forEach(row => seedProduct.run(...row));

const faqRows = [
  ['delivery-time', 'How long does delivery take?', 'Most orders arrive in 30–45 minutes. Your order page shows the latest estimated time.'],
  ['cancel-change', 'Can I cancel or change my order?', 'You can request a change while the restaurant is still preparing your food. Share your order ID and we’ll check.'],
  ['payment-methods', 'What payment methods do you accept?', 'Zaykaa accepts UPI, cards, net banking and cash on delivery where available.'],
  ['vegetarian', 'Do you have vegetarian options?', 'Yes. Try the Paneer Tikka Bowl, Masala Dosa or Veg Hakka Noodles.'],
  ['missing-item', 'How do I get help with a missing or incorrect item?', 'Share your order ID and describe the issue. A support teammate can help with a replacement or refund.'],
  ['delivery-fee', 'Is there a delivery fee?', 'Delivery fees vary by distance and are shown at checkout before you place an order.'],
  ['scheduled-order', 'Can I schedule an order?', 'Scheduled delivery is available for select restaurants. Choose a time at checkout.']
];
const seedFaq = db.prepare(`
  INSERT INTO faq_documents (id, question, answer) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    embedding_model = CASE WHEN faq_documents.question != excluded.question OR faq_documents.answer != excluded.answer THEN NULL ELSE faq_documents.embedding_model END,
    embedding_dimensions = CASE WHEN faq_documents.question != excluded.question OR faq_documents.answer != excluded.answer THEN NULL ELSE faq_documents.embedding_dimensions END,
    embedding_json = CASE WHEN faq_documents.question != excluded.question OR faq_documents.answer != excluded.answer THEN NULL ELSE faq_documents.embedding_json END,
    question = excluded.question,
    answer = excluded.answer,
    updated_at = CASE WHEN faq_documents.question != excluded.question OR faq_documents.answer != excluded.answer THEN CURRENT_TIMESTAMP ELSE faq_documents.updated_at END
`);
faqRows.forEach(row => seedFaq.run(...row));

module.exports = { db };
