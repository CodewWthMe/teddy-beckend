const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const MONGODB_URI = process.env.MONGODB_URI || null;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ──────────────────────────────────────────
// IN-MEMORY FALLBACK (used if no MONGODB_URI)
// ──────────────────────────────────────────

const mem = {
    products: [
        { id: 1, name: 'Macrame Wall Hanging', description: 'Beautiful handmade macrame', price: 599, discount: 10, type: 'Wall Hanging', featured: true, images: ['https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=600'], video: null },
        { id: 2, name: 'Macrame Plant Hanger', description: 'Stylish plant hanger for your home', price: 399, discount: 0, type: 'Plant Hanger', featured: true, images: ['https://images.unsplash.com/photo-1592150621744-aca64f48394a?w=600'], video: null }
    ],
    productTypes: ['Wall Hanging', 'Plant Hanger', 'Table Runner', 'Bag', 'Keychain'],
    settings: { businessEmail: 'curledmacrame@gmail.com', businessWhatsApp: '+917415036637' },
    orders: [],
    adminPasswordHash: null
};

// ──────────────────────────────────────────
// MONGOOSE MODELS
// ──────────────────────────────────────────

const ProductSchema = new mongoose.Schema({
    id: Number,
    name: String,
    description: String,
    price: Number,
    discount: { type: Number, default: 0 },
    type: String,
    featured: { type: Boolean, default: true },
    images: [String],
    video: { type: String, default: null }
});

const StoreSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});

let Product, Store;
let useDB = false;

async function connectDB() {
    if (!MONGODB_URI) {
        console.log('No MONGODB_URI set — using in-memory storage');
        return;
    }
    try {
        await mongoose.connect(MONGODB_URI);
        Product = mongoose.model('Product', ProductSchema);
        Store = mongoose.model('Store', StoreSchema);
        useDB = true;
        console.log('Connected to MongoDB');

        const count = await Product.countDocuments();
        if (count === 0) {
            await Product.insertMany(mem.products);
            console.log('Seeded default products');
        }
        const types = await Store.findOne({ key: 'productTypes' });
        if (!types) await Store.create({ key: 'productTypes', value: mem.productTypes });
        const settings = await Store.findOne({ key: 'settings' });
        if (!settings) await Store.create({ key: 'settings', value: mem.settings });
        const admin = await Store.findOne({ key: 'adminPasswordHash' });
        if (!admin) await Store.create({ key: 'adminPasswordHash', value: null });
    } catch (err) {
        console.error('MongoDB connection failed:', err.message);
        console.log('Falling back to in-memory storage');
    }
}

// ──────────────────────────────────────────
// DATA HELPERS
// ──────────────────────────────────────────

async function getProducts() {
    if (useDB) return await Product.find({}, '-_id -__v').lean();
    return mem.products;
}

async function saveProduct(product) {
    if (useDB) {
        const p = new Product(product);
        await p.save();
        return product;
    }
    mem.products.push(product);
    return product;
}

async function updateProduct(id, data) {
    if (useDB) {
        await Product.updateOne({ id }, { $set: data });
        return await Product.findOne({ id }, '-_id -__v').lean();
    }
    const idx = mem.products.findIndex(p => p.id === id);
    if (idx === -1) return null;
    mem.products[idx] = { ...mem.products[idx], ...data };
    return mem.products[idx];
}

async function deleteProduct(id) {
    if (useDB) { await Product.deleteOne({ id }); return; }
    mem.products = mem.products.filter(p => p.id !== id);
}

async function getNextProductId() {
    if (useDB) {
        const last = await Product.findOne({}).sort({ id: -1 }).lean();
        return last ? last.id + 1 : 1;
    }
    return Math.max(...mem.products.map(p => p.id), 0) + 1;
}

async function getStoreValue(key) {
    if (useDB) {
        const doc = await Store.findOne({ key }).lean();
        return doc ? doc.value : null;
    }
    return mem[key];
}

async function setStoreValue(key, value) {
    if (useDB) {
        await Store.updateOne({ key }, { $set: { value } }, { upsert: true });
        return;
    }
    mem[key] = value;
}

// ──────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
        jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ──────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ message: 'Curled Macrame API is running', status: 'ok', db: useDB ? 'mongodb' : 'memory' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: useDB ? 'mongodb' : 'memory', time: new Date().toISOString() });
});

// Admin auth
app.post('/api/admin/login', async (req, res) => {
    try {
        const { passwordHash } = req.body;
        if (!passwordHash) return res.status(400).json({ error: 'Password required' });

        const stored = await getStoreValue('adminPasswordHash');

        if (!stored) {
            await setStoreValue('adminPasswordHash', passwordHash);
            const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, firstTime: true, message: 'Password created' });
        }

        if (stored === passwordHash) {
            const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token });
        }

        res.status(401).json({ error: 'Wrong password' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Products
app.get('/api/products', async (req, res) => {
    try { res.json(await getProducts()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products', requireAdmin, async (req, res) => {
    try {
        const product = { ...req.body, id: await getNextProductId() };
        res.json(await saveProduct(product));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
    try {
        const updated = await updateProduct(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
    try {
        await deleteProduct(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Product types
app.get('/api/product-types', async (req, res) => {
    try { res.json(await getStoreValue('productTypes') || []); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/product-types', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const types = await getStoreValue('productTypes') || [];
        if (types.includes(name)) return res.status(400).json({ error: 'Type already exists' });
        types.push(name);
        await setStoreValue('productTypes', types);
        res.json(types);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/product-types/:name', requireAdmin, async (req, res) => {
    try {
        const types = (await getStoreValue('productTypes') || []).filter(t => t !== req.params.name);
        await setStoreValue('productTypes', types);
        res.json(types);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Settings
app.get('/api/settings', async (req, res) => {
    try { res.json(await getStoreValue('settings') || {}); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', requireAdmin, async (req, res) => {
    try {
        const current = await getStoreValue('settings') || {};
        const updated = { ...current, ...req.body };
        await setStoreValue('settings', updated);
        res.json(updated);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Orders
app.get('/api/orders', requireAdmin, async (req, res) => {
    try { res.json(await getStoreValue('orders') || []); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        const order = { ...req.body, timestamp: Date.now(), date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) };
        const orders = await getStoreValue('orders') || [];
        orders.unshift(order);
        await setStoreValue('orders', orders);
        res.json(order);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:timestamp', requireAdmin, async (req, res) => {
    try {
        const orders = (await getStoreValue('orders') || []).filter(o => o.timestamp !== parseInt(req.params.timestamp));
        await setStoreValue('orders', orders);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log('Curled Macrame API running on port ' + PORT);
    });
});
