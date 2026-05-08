const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ──────────────────────────────────────────
// IN-MEMORY DATA STORE
// No file system — works perfectly on Render free tier
// Note: data resets when Render restarts the service
// ──────────────────────────────────────────

const db = {
    products: [
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
    ],
    productTypes: ['Wall Hanging', 'Plant Hanger', 'Table Runner', 'Bag', 'Keychain'],
    settings: {
        businessEmail: 'curledmacrame@gmail.com',
        businessWhatsApp: '+917415036637'
    },
    orders: [],
    adminPasswordHash: null
};

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
// ROUTES: HEALTH
// ──────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({ message: 'Curled Macrame API is running', status: 'ok' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ──────────────────────────────────────────
// ROUTES: ADMIN AUTH
// ──────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
    try {
        const { passwordHash } = req.body;
        if (!passwordHash) {
            return res.status(400).json({ error: 'Password required' });
        }

        if (!db.adminPasswordHash) {
            db.adminPasswordHash = passwordHash;
            const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, firstTime: true, message: 'Password created' });
        }

        if (db.adminPasswordHash === passwordHash) {
            const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token });
        }

        res.status(401).json({ error: 'Wrong password' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────
// ROUTES: PRODUCTS
// ──────────────────────────────────────────

app.get('/api/products', (req, res) => {
    res.json(db.products);
});

app.post('/api/products', requireAdmin, (req, res) => {
    try {
        const product = req.body;
        product.id = Math.max(...db.products.map(p => p.id), 0) + 1;
        db.products.push(product);
        res.json(product);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
    try {
        const idx = db.products.findIndex(p => p.id === parseInt(req.params.id));
        if (idx === -1) return res.status(404).json({ error: 'Product not found' });
        db.products[idx] = { ...db.products[idx], ...req.body };
        res.json(db.products[idx]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
    try {
        db.products = db.products.filter(p => p.id !== parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────
// ROUTES: PRODUCT TYPES
// ──────────────────────────────────────────

app.get('/api/product-types', (req, res) => {
    res.json(db.productTypes);
});

app.post('/api/product-types', requireAdmin, (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        if (db.productTypes.includes(name)) {
            return res.status(400).json({ error: 'Type already exists' });
        }
        db.productTypes.push(name);
        res.json(db.productTypes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/product-types/:name', requireAdmin, (req, res) => {
    try {
        db.productTypes = db.productTypes.filter(t => t !== req.params.name);
        res.json(db.productTypes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────
// ROUTES: SETTINGS
// ──────────────────────────────────────────

app.get('/api/settings', (req, res) => {
    res.json(db.settings);
});

app.post('/api/settings', requireAdmin, (req, res) => {
    try {
        db.settings = { ...db.settings, ...req.body };
        res.json(db.settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────
// ROUTES: ORDERS
// ──────────────────────────────────────────

app.get('/api/orders', requireAdmin, (req, res) => {
    res.json(db.orders);
});

app.post('/api/orders', (req, res) => {
    try {
        const order = {
            ...req.body,
            timestamp: Date.now(),
            date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        };
        db.orders.unshift(order);
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/orders/:timestamp', requireAdmin, (req, res) => {
    try {
        db.orders = db.orders.filter(
            o => o.timestamp !== parseInt(req.params.timestamp)
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────

app.listen(PORT, () => {
    console.log('Curled Macrame API running on port ' + PORT);
});
