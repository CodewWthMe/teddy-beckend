const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

const STORAGE_DIR = path.join(__dirname, 'server-storage');
const DATA_FILE = path.join(STORAGE_DIR, 'data.json');

// ──────────────────────────────────────────
// CORS — replace YOUR_NETLIFY_URL with your
// actual Netlify site URL after you deploy
// ──────────────────────────────────────────
const ALLOWED_ORIGINS = [
    'https://mecramecurled.netlify.app/',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ──────────────────────────────────────────
// DEFAULT DATA
// ──────────────────────────────────────────

const DEFAULT_PRODUCTS = [
    {
        id: 1,
        name: 'Macrame Wall Hanging',
        description: 'Beautiful handmade macrame wall hanging',
        price: 599,
        discount: 10,
        type: 'Wall Hanging',
        featured: true,
        images: ['https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=600'],
        video: null
    },
    {
        id: 2,
        name: 'Macrame Plant Hanger',
        description: 'Stylish plant hanger for your home',
        price: 399,
        discount: 0,
        type: 'Plant Hanger',
        featured: true,
        images: ['https://images.unsplash.com/photo-1592150621744-aca64f48394a?w=600'],
        video: null
    }
];

const DEFAULT_TYPES = [
    'Wall Hanging',
    'Plant Hanger',
    'Table Runner',
    'Bag',
    'Keychain'
];

const DEFAULT_SETTINGS = {
    businessEmail: 'curledmacrame@gmail.com',
    businessWhatsApp: '+917415036637'
};

// ──────────────────────────────────────────
// STORAGE HELPERS
// ──────────────────────────────────────────

function ensureStorage() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
        writeData({
            products: DEFAULT_PRODUCTS,
            productTypes: DEFAULT_TYPES,
            settings: DEFAULT_SETTINGS,
            orders: [],
            adminPasswordHash: null
        });
    }
}

function readData() {
    ensureStorage();
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return {
            products: DEFAULT_PRODUCTS,
            productTypes: DEFAULT_TYPES,
            settings: DEFAULT_SETTINGS,
            orders: [],
            adminPasswordHash: null
        };
    }
}

function writeData(data) {
    ensureStorage();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ──────────────────────────────────────────
// JWT MIDDLEWARE
// ──────────────────────────────────────────

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ──────────────────────────────────────────
// ROUTES: ADMIN AUTH
// ──────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
    const { passwordHash } = req.body;
    if (!passwordHash) {
        return res.status(400).json({ error: 'Password required' });
    }

    const data = readData();

    if (!data.adminPasswordHash) {
        data.adminPasswordHash = passwordHash;
        writeData(data);
        const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, firstTime: true, message: 'Password created' });
    }

    if (data.adminPasswordHash === passwordHash) {
        const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token });
    }

    res.status(401).json({ error: 'Wrong password' });
});

// ──────────────────────────────────────────
// ROUTES: PRODUCTS
// ──────────────────────────────────────────

app.get('/api/products', (req, res) => {
    const data = readData();
    res.json(data.products);
});

app.post('/api/products', requireAdmin, (req, res) => {
    const data = readData();
    const product = req.body;
    product.id = Math.max(...data.products.map(p => p.id), 0) + 1;
    data.products.push(product);
    writeData(data);
    res.json(product);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
    const data = readData();
    const idx = data.products.findIndex(p => p.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Product not found' });
    data.products[idx] = { ...data.products[idx], ...req.body };
    writeData(data);
    res.json(data.products[idx]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
    const data = readData();
    data.products = data.products.filter(p => p.id !== parseInt(req.params.id));
    writeData(data);
    res.json({ success: true });
});

// ──────────────────────────────────────────
// ROUTES: PRODUCT TYPES
// ──────────────────────────────────────────

app.get('/api/product-types', (req, res) => {
    const data = readData();
    res.json(data.productTypes);
});

app.post('/api/product-types', requireAdmin, (req, res) => {
    const data = readData();
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (data.productTypes.includes(name)) {
        return res.status(400).json({ error: 'Type already exists' });
    }
    data.productTypes.push(name);
    writeData(data);
    res.json(data.productTypes);
});

app.delete('/api/product-types/:name', requireAdmin, (req, res) => {
    const data = readData();
    data.productTypes = data.productTypes.filter(t => t !== req.params.name);
    writeData(data);
    res.json(data.productTypes);
});

// ──────────────────────────────────────────
// ROUTES: SETTINGS
// ──────────────────────────────────────────

app.get('/api/settings', (req, res) => {
    const data = readData();
    res.json(data.settings);
});

app.post('/api/settings', requireAdmin, (req, res) => {
    const data = readData();
    data.settings = { ...data.settings, ...req.body };
    writeData(data);
    res.json(data.settings);
});

// ──────────────────────────────────────────
// ROUTES: ORDERS
// ──────────────────────────────────────────

app.get('/api/orders', requireAdmin, (req, res) => {
    const data = readData();
    res.json(data.orders);
});

app.post('/api/orders', (req, res) => {
    const data = readData();
    const order = {
        ...req.body,
        timestamp: Date.now(),
        date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };
    data.orders.unshift(order);
    writeData(data);
    res.json(order);
});

app.delete('/api/orders/:timestamp', requireAdmin, (req, res) => {
    const data = readData();
    data.orders = data.orders.filter(
        o => o.timestamp !== parseInt(req.params.timestamp)
    );
    writeData(data);
    res.json({ success: true });
});

// ──────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────

ensureStorage();
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
