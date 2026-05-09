const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const compression = require('compression');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const MONGODB_URI = process.env.MONGODB_URI || null;

// Configure Cloudinary
const CLOUDINARY_CONFIGURED = !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_CONFIGURED) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('Cloudinary configured');
} else {
    console.log('Cloudinary not configured — image upload will use URLs only');
}

app.use(compression());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ──────────────────────────────────────────
// IN-MEMORY FALLBACK (only if MongoDB unavailable)
// ──────────────────────────────────────────
const mem = {
    products: [],
    productTypes: ['Wall Hanging', 'Plant Hanger', 'Table Runner', 'Bag', 'Keychain'],
    settings: { businessEmail: 'curledmacrame@gmail.com', businessWhatsApp: '+917415036637' },
    orders: [],
    adminPasswordHash: null
};

// ──────────────────────────────────────────
// MONGOOSE MODELS
// ──────────────────────────────────────────
const ProductSchema = new mongoose.Schema({
    id: { type: Number, index: true },
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    type: String,
    featured: { type: Boolean, default: true },
    stock: { type: Number, default: 99 },
    images: [String],   // Cloudinary URLs (not base64)
    video: { type: String, default: null }
}, { timestamps: true });

const StoreSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});

let Product, Store;
let useDB = false;

async function connectDB() {
    if (!MONGODB_URI) {
        console.warn('⚠️  MONGODB_URI not set — products will be lost on restart! Add it to Render environment variables.');
        return;
    }
    try {
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000
        });
        Product = mongoose.model('Product', ProductSchema);
        Store = mongoose.model('Store', StoreSchema);
        useDB = true;
        console.log('✅ Connected to MongoDB');

        // Seed defaults only if empty
        if (!await Store.findOne({ key: 'productTypes' }))
            await Store.create({ key: 'productTypes', value: mem.productTypes });
        if (!await Store.findOne({ key: 'settings' }))
            await Store.create({ key: 'settings', value: mem.settings });
        if (!await Store.findOne({ key: 'adminPasswordHash' }))
            await Store.create({ key: 'adminPasswordHash', value: null });
        if (!await Store.findOne({ key: 'orders' }))
            await Store.create({ key: 'orders', value: [] });
    } catch (err) {
        console.error('❌ MongoDB connection failed:', err.message);
        console.warn('⚠️  Running in-memory — data will be lost on restart!');
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
    if (useDB) { await new Product(product).save(); return product; }
    mem.products.push(product); return product;
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
async function deleteProductById(id) {
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
    return mem[key] ?? null;
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
    try { jwt.verify(auth.slice(7), JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ──────────────────────────────────────────
// IMAGE UPLOAD — Cloudinary
// ──────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max per file
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files allowed'));
    }
});

// Upload image → Cloudinary → return URL
app.post('/api/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });

        if (!CLOUDINARY_CONFIGURED) {
            // Fallback: accept a URL passed in body instead
            return res.status(503).json({ error: 'Cloudinary not configured. Add CLOUDINARY_* env vars to Render.' });
        }

        // Upload buffer to Cloudinary
        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: 'curled-macrame', resource_type: 'image', quality: 'auto', fetch_format: 'auto' },
                (error, result) => error ? reject(error) : resolve(result)
            );
            stream.end(req.file.buffer);
        });

        res.json({ url: result.secure_url, publicId: result.public_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete image from Cloudinary (called when admin removes a product)
async function deleteCloudinaryImage(imageUrl) {
    if (!CLOUDINARY_CONFIGURED || !imageUrl || !imageUrl.includes('cloudinary')) return;
    try {
        const parts = imageUrl.split('/');
        const publicId = parts.slice(parts.indexOf('curled-macrame')).join('/').replace(/\.[^.]+$/, '');
        await cloudinary.uploader.destroy(publicId);
    } catch (err) {
        console.error('Cloudinary delete failed:', err.message);
    }
}

// ──────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────
app.get('/', (req, res) => res.json({
    message: 'Curled Macrame API', status: 'ok',
    db: useDB ? 'mongodb' : 'memory (⚠️ set MONGODB_URI in Render!)',
    cloudinary: CLOUDINARY_CONFIGURED ? 'configured' : 'not configured'
}));

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    db: useDB ? 'mongodb' : 'memory',
    cloudinary: CLOUDINARY_CONFIGURED,
    time: new Date().toISOString()
}));

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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Products
app.get('/api/products', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
        res.json(await getProducts());
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        const id = parseInt(req.params.id);
        // Delete images from Cloudinary
        const products = await getProducts();
        const product = products.find(p => p.id === id);
        if (product && product.images) {
            await Promise.all(product.images.map(url => deleteCloudinaryImage(url)));
        }
        await deleteProductById(id);
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
        if (types.includes(name)) return res.status(400).json({ error: 'Already exists' });
        types.push(name); await setStoreValue('productTypes', types); res.json(types);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/product-types/:name', requireAdmin, async (req, res) => {
    try {
        const types = (await getStoreValue('productTypes') || []).filter(t => t !== req.params.name);
        await setStoreValue('productTypes', types); res.json(types);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Settings
app.get('/api/settings', async (req, res) => {
    try { res.json(await getStoreValue('settings') || {}); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/settings', requireAdmin, async (req, res) => {
    try {
        const updated = { ...(await getStoreValue('settings') || {}), ...req.body };
        await setStoreValue('settings', updated); res.json(updated);
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
        orders.unshift(order); await setStoreValue('orders', orders); res.json(order);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/orders/:timestamp', requireAdmin, async (req, res) => {
    try {
        const orders = (await getStoreValue('orders') || []).filter(o => o.timestamp !== parseInt(req.params.timestamp));
        await setStoreValue('orders', orders); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start
connectDB().then(() => app.listen(PORT, () => {
    console.log(`Curled Macrame API on port ${PORT} | DB: ${useDB ? 'MongoDB' : 'memory'} | Cloudinary: ${CLOUDINARY_CONFIGURED ? 'yes' : 'no'}`);
}));
