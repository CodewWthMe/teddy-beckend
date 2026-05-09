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

// ─────────────────────────────────────────────
//  CHECK REQUIRED ENV VARS BEFORE ANYTHING ELSE
// ─────────────────────────────────────────────
if (!MONGODB_URI) {
    console.error('');
    console.error('FATAL: MONGODB_URI is not set.');
    console.error('Go to Render Dashboard → Your Service → Environment → Add Variable:');
    console.error('  Key:   MONGODB_URI');
    console.error('  Value: mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/curled-macrame');
    console.error('');
    process.exit(1);
}

if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET is not set. Using insecure default.');
    console.warn('Add JWT_SECRET on Render with a long random string.');
}

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
    console.log('Cloudinary: configured');
} else {
    console.warn('Cloudinary: NOT configured — image uploads will fail until you add the env vars');
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(compression());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─────────────────────────────────────────────
//  MONGOOSE MODELS
// ─────────────────────────────────────────────
const ProductSchema = new mongoose.Schema({
    id:          { type: Number, index: true },
    name:        { type: String, required: true },
    description: String,
    price:       { type: Number, required: true },
    discount:    { type: Number, default: 0 },
    type:        String,
    featured:    { type: Boolean, default: true },
    stock:       { type: Number, default: 99 },
    images:      [String],
    video:       { type: String, default: null }
}, { timestamps: true });

const StoreSchema = new mongoose.Schema({
    key:   { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});

// Defined at module load — they are only used after MongoDB connects
const Product = mongoose.model('Product', ProductSchema);
const Store   = mongoose.model('Store',   StoreSchema);

// ─────────────────────────────────────────────
//  DB HELPERS  — no in-memory fallback
// ─────────────────────────────────────────────
async function getProducts()           { return await Product.find({}, '-_id -__v').lean(); }
async function saveProduct(p)          { await new Product(p).save(); return p; }
async function deleteProductById(id)   { await Product.deleteOne({ id }); }

async function updateProduct(id, data) {
    await Product.updateOne({ id }, { $set: data });
    return await Product.findOne({ id }, '-_id -__v').lean();
}

async function getNextId() {
    const last = await Product.findOne({}).sort({ id: -1 }).lean();
    return last ? last.id + 1 : 1;
}

async function getStoreValue(key) {
    const doc = await Store.findOne({ key }).lean();
    return doc ? doc.value : null;
}

async function setStoreValue(key, value) {
    await Store.updateOne({ key }, { $set: { value } }, { upsert: true });
}

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─────────────────────────────────────────────
//  FILE UPLOAD (MULTER + CLOUDINARY)
// ─────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },   // 10 MB per image
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    }
});

async function uploadToCloudinary(buffer, folder) {
    if (!CLOUDINARY_CONFIGURED) {
        throw new Error(
            'Cloudinary is not configured on Render. ' +
            'Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET ' +
            'in Render Dashboard → Environment.'
        );
    }
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: 'image', quality: 'auto', fetch_format: 'auto' },
            (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
    });
}

async function deleteCloudinaryImage(url) {
    if (!CLOUDINARY_CONFIGURED || !url || !url.includes('cloudinary')) return;
    try {
        const parts = url.split('/');
        const idx   = parts.findIndex(p => p === 'curled-macrame');
        if (idx === -1) return;
        const pid = parts.slice(idx).join('/').replace(/\.[^.]+$/, '');
        await cloudinary.uploader.destroy(pid);
    } catch (err) {
        console.error('Cloudinary delete error:', err.message);
    }
}

// ─────────────────────────────────────────────
//  ROUTES — HEALTH / KEEP-ALIVE
// ─────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
    message:    'Curled Macrame API',
    db:         mongoose.connection.readyState === 1 ? 'mongodb' : 'disconnected',
    cloudinary: CLOUDINARY_CONFIGURED
}));

// UptimeRobot pings this every 5 minutes so Render never sleeps
app.get('/api/health', (_req, res) => res.json({
    status:     'ok',
    db:         mongoose.connection.readyState === 1 ? 'mongodb' : 'disconnected',
    cloudinary: CLOUDINARY_CONFIGURED,
    time:       new Date().toISOString()
}));

// ─────────────────────────────────────────────
//  ROUTES — IMAGE UPLOAD
// ─────────────────────────────────────────────
app.post('/api/upload-image',
    requireAdmin,
    upload.single('image'),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No image provided' });
            const result = await uploadToCloudinary(req.file.buffer, 'curled-macrame');
            res.json({ url: result.secure_url, publicId: result.public_id });
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

app.post('/api/upload-payment-screenshot',
    upload.single('image'),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No image provided' });
            const result = await uploadToCloudinary(req.file.buffer, 'curled-macrame-payments');
            res.json({ url: result.secure_url, publicId: result.public_id });
        } catch (err) {
            console.error('Payment screenshot upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

// ─────────────────────────────────────────────
//  ROUTES — ADMIN LOGIN
// ─────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
    try {
        const { passwordHash } = req.body;
        if (!passwordHash) return res.status(400).json({ error: 'Password required' });

        const stored = await getStoreValue('adminPasswordHash');

        if (!stored) {
            // First ever login — save the password
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

// ─────────────────────────────────────────────
//  ROUTES — PRODUCTS
// ─────────────────────────────────────────────
app.get('/api/products', async (_req, res) => {
    try {
        res.set('Cache-Control', 'public,max-age=30,stale-while-revalidate=60');
        res.json(await getProducts());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', requireAdmin, async (req, res) => {
    try {
        const p = { ...req.body, id: await getNextId() };
        res.json(await saveProduct(p));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
    try {
        const updated = await updateProduct(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ error: 'Product not found' });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
    try {
        const id       = parseInt(req.params.id);
        const products = await getProducts();
        const product  = products.find(p => p.id === id);
        if (product && product.images) {
            await Promise.all(product.images.map(url => deleteCloudinaryImage(url)));
        }
        await deleteProductById(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — PRODUCT TYPES
// ─────────────────────────────────────────────
app.get('/api/product-types', async (_req, res) => {
    try {
        res.json(await getStoreValue('productTypes') || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/product-types/:name', requireAdmin, async (req, res) => {
    try {
        const types = (await getStoreValue('productTypes') || []).filter(t => t !== req.params.name);
        await setStoreValue('productTypes', types);
        res.json(types);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — SETTINGS
// ─────────────────────────────────────────────
app.get('/api/settings', async (_req, res) => {
    try {
        res.json(await getStoreValue('settings') || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', requireAdmin, async (req, res) => {
    try {
        const current = await getStoreValue('settings') || {};
        const updated = { ...current, ...req.body };
        await setStoreValue('settings', updated);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
//  ROUTES — ORDERS
// ─────────────────────────────────────────────
app.get('/api/orders', requireAdmin, async (_req, res) => {
    try {
        res.json(await getStoreValue('orders') || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/orders', async (req, res) => {
    try {
        const order = {
            ...req.body,
            timestamp: Date.now(),
            date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
        const orders = await getStoreValue('orders') || [];
        orders.unshift(order);
        await setStoreValue('orders', orders);
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/orders/:timestamp', requireAdmin, async (req, res) => {
    try {
        const ts     = parseInt(req.params.timestamp);
        const orders = (await getStoreValue('orders') || []).filter(o => o.timestamp !== ts);
        await setStoreValue('orders', orders);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
//  STARTUP — Connect to MongoDB FIRST
//
//  THE ROOT CAUSE OF ALL BUGS:
//  The old code started the HTTP server immediately and used RAM
//  when MongoDB wasn't connected yet. Render free tier restarts
//  every 15 min of inactivity → RAM wiped → products gone.
//
//  Now: we wait for MongoDB. If it fails, we exit so Render retries.
//  No RAM fallback. Data is ALWAYS in MongoDB.
// ─────────────────────────────────────────────
async function startServer() {
    const MAX_RETRIES   = 5;
    const RETRY_DELAY   = 3000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`Connecting to MongoDB (attempt ${attempt}/${MAX_RETRIES})...`);
            await mongoose.connect(MONGODB_URI, {
                serverSelectionTimeoutMS: 10000,
                socketTimeoutMS:          45000
            });
            console.log('MongoDB connected successfully');
            break;
        } catch (err) {
            console.error(`MongoDB connection failed: ${err.message}`);
            if (attempt === MAX_RETRIES) {
                console.error('');
                console.error('Could not connect after all retries. Server will NOT start.');
                console.error('');
                console.error('Things to check:');
                console.error('  1. Is MONGODB_URI correct in Render Environment Variables?');
                console.error('  2. MongoDB Atlas → Network Access → is 0.0.0.0/0 allowed?');
                console.error('  3. Is your MongoDB Atlas cluster running (not paused)?');
                process.exit(1);
            }
            console.log(`Waiting ${RETRY_DELAY / 1000}s before retry...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
    }

    // Seed default values only on a fresh database
    const defaults = {
        productTypes: ['Wall Hanging', 'Plant Hanger', 'Table Runner', 'Bag', 'Keychain'],
        settings: {
            businessEmail:     'curledmacrame@gmail.com',
            businessWhatsApp:  '+917415036637',
            paytmQrImage:      'Your-qr-image.png'
        },
        adminPasswordHash: null,
        orders:            []
    };

    for (const [key, value] of Object.entries(defaults)) {
        if (!await Store.findOne({ key })) {
            await Store.create({ key, value });
        }
    }

    // Fix QR image name in existing databases (old default was paytm-qr.png)
    const existingSettings = await getStoreValue('settings');
    if (existingSettings && existingSettings.paytmQrImage === 'paytm-qr.png') {
        await setStoreValue('settings', { ...existingSettings, paytmQrImage: 'Your-qr-image.png' });
        console.log('Updated QR image filename to Your-qr-image.png');
    }

    // Always enforce fixed admin password: macrame@123
    // This means only you can access admin on any browser — nobody can change it
    const FIXED_ADMIN_HASH = '97813a1ebf35ee3132890b1e687bccdf19a4f39a89256ac03ecffe1a2cef2d8b';
    await setStoreValue('adminPasswordHash', FIXED_ADMIN_HASH);
    console.log('Admin password locked to macrame@123');

    app.listen(PORT, () => {
        console.log('');
        console.log(`Curled Macrame API running on port ${PORT}`);
        console.log(`  Database:   MongoDB (permanent storage — products never lost)`);
        console.log(`  Cloudinary: ${CLOUDINARY_CONFIGURED ? 'ready (image uploads work)' : 'NOT SET — add env vars to enable images'}`);
        console.log('');
    });
}

startServer();
