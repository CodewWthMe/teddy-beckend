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

const CLOUDINARY_CONFIGURED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_CONFIGURED) {
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    console.log('✅ Cloudinary configured');
} else { console.warn('⚠️  Cloudinary not configured — add CLOUDINARY_* env vars'); }

app.use(compression());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── IN-MEMORY FALLBACK ──
const mem = {
    products: [], productTypes: ['Wall Hanging','Plant Hanger','Table Runner','Bag','Keychain'],
    settings: { businessEmail: 'curledmacrame@gmail.com', businessWhatsApp: '+917415036637', paytmQrImage: 'paytm-qr.png' },
    orders: [], adminPasswordHash: null
};

// ── MONGOOSE MODELS ──
const ProductSchema = new mongoose.Schema({ id: { type: Number, index: true }, name: { type: String, required: true }, description: String, price: { type: Number, required: true }, discount: { type: Number, default: 0 }, type: String, featured: { type: Boolean, default: true }, stock: { type: Number, default: 99 }, images: [String], video: { type: String, default: null } }, { timestamps: true });
const StoreSchema = new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed });

let Product, Store, useDB = false;

async function connectDB() {
    if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI not set — data lost on restart!'); return; }
    try {
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });
        Product = mongoose.model('Product', ProductSchema);
        Store = mongoose.model('Store', StoreSchema);
        useDB = true;
        console.log('✅ MongoDB connected');
        if (!await Store.findOne({ key: 'productTypes' })) await Store.create({ key: 'productTypes', value: mem.productTypes });
        if (!await Store.findOne({ key: 'settings' })) await Store.create({ key: 'settings', value: mem.settings });
        if (!await Store.findOne({ key: 'adminPasswordHash' })) await Store.create({ key: 'adminPasswordHash', value: null });
        if (!await Store.findOne({ key: 'orders' })) await Store.create({ key: 'orders', value: [] });
    } catch (err) { console.error('❌ MongoDB failed:', err.message); }
}

async function getProducts() { return useDB ? await Product.find({}, '-_id -__v').lean() : mem.products; }
async function saveProduct(p) { if (useDB) { await new Product(p).save(); return p; } mem.products.push(p); return p; }
async function updateProduct(id, data) { if (useDB) { await Product.updateOne({id},{$set:data}); return await Product.findOne({id},'-_id -__v').lean(); } const i=mem.products.findIndex(p=>p.id===id); if(i===-1)return null; mem.products[i]={...mem.products[i],...data}; return mem.products[i]; }
async function deleteProductById(id) { if (useDB) { await Product.deleteOne({id}); return; } mem.products=mem.products.filter(p=>p.id!==id); }
async function getNextId() { if (useDB) { const l=await Product.findOne({}).sort({id:-1}).lean(); return l?l.id+1:1; } return Math.max(...mem.products.map(p=>p.id),0)+1; }
async function getStoreValue(key) { if (useDB) { const d=await Store.findOne({key}).lean(); return d?d.value:null; } return mem[key]??null; }
async function setStoreValue(key, value) { if (useDB) { await Store.updateOne({key},{$set:{value}},{upsert:true}); return; } mem[key]=value; }

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try { jwt.verify(auth.slice(7), JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── MULTER ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('Only images allowed')); } });

async function uploadToCloudinary(buffer, folder) {
    if (!CLOUDINARY_CONFIGURED) throw new Error('Cloudinary not configured — add CLOUDINARY_* env vars on Render');
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'image', quality: 'auto', fetch_format: 'auto' }, (err, result) => err ? reject(err) : resolve(result));
        stream.end(buffer);
    });
}

// Upload product image (admin only)
app.post('/api/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image provided' });
        const result = await uploadToCloudinary(req.file.buffer, 'curled-macrame');
        res.json({ url: result.secure_url, publicId: result.public_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload payment screenshot (public — no token required)
app.post('/api/upload-payment-screenshot', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image provided' });
        const result = await uploadToCloudinary(req.file.buffer, 'curled-macrame-payments');
        res.json({ url: result.secure_url, publicId: result.public_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function deleteCloudinaryImage(url) {
    if (!CLOUDINARY_CONFIGURED || !url || !url.includes('cloudinary')) return;
    try { const parts=url.split('/'); const pid=parts.slice(parts.findIndex(p=>p==='curled-macrame')).join('/').replace(/\.[^.]+$/,''); await cloudinary.uploader.destroy(pid); } catch(err) { console.error('Cloudinary delete failed:', err.message); }
}

// ── ROUTES ──
app.get('/', (req, res) => res.json({ message: 'Curled Macrame API', db: useDB ? 'mongodb' : 'memory ⚠️', cloudinary: CLOUDINARY_CONFIGURED }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: useDB ? 'mongodb' : 'memory', cloudinary: CLOUDINARY_CONFIGURED, time: new Date().toISOString() }));

app.post('/api/admin/login', async (req, res) => {
    try {
        const { passwordHash } = req.body;
        if (!passwordHash) return res.status(400).json({ error: 'Password required' });
        const stored = await getStoreValue('adminPasswordHash');
        if (!stored) { await setStoreValue('adminPasswordHash', passwordHash); const token=jwt.sign({admin:true},JWT_SECRET,{expiresIn:'7d'}); return res.json({token,firstTime:true,message:'Password created'}); }
        if (stored === passwordHash) { const token=jwt.sign({admin:true},JWT_SECRET,{expiresIn:'7d'}); return res.json({token}); }
        res.status(401).json({ error: 'Wrong password' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products', async (req, res) => { try { res.set('Cache-Control','public,max-age=30,stale-while-revalidate=60'); res.json(await getProducts()); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/products', requireAdmin, async (req, res) => { try { const p={...req.body,id:await getNextId()}; res.json(await saveProduct(p)); } catch(err) { res.status(500).json({error:err.message}); } });
app.put('/api/products/:id', requireAdmin, async (req, res) => { try { const u=await updateProduct(parseInt(req.params.id),req.body); if(!u) return res.status(404).json({error:'Not found'}); res.json(u); } catch(err) { res.status(500).json({error:err.message}); } });
app.delete('/api/products/:id', requireAdmin, async (req, res) => { try { const id=parseInt(req.params.id); const products=await getProducts(); const p=products.find(x=>x.id===id); if(p&&p.images) await Promise.all(p.images.map(u=>deleteCloudinaryImage(u))); await deleteProductById(id); res.json({success:true}); } catch(err) { res.status(500).json({error:err.message}); } });

app.get('/api/product-types', async (req, res) => { try { res.json(await getStoreValue('productTypes')||[]); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/product-types', requireAdmin, async (req, res) => { try { const {name}=req.body; if(!name) return res.status(400).json({error:'Name required'}); const types=await getStoreValue('productTypes')||[]; if(types.includes(name)) return res.status(400).json({error:'Already exists'}); types.push(name); await setStoreValue('productTypes',types); res.json(types); } catch(err) { res.status(500).json({error:err.message}); } });
app.delete('/api/product-types/:name', requireAdmin, async (req, res) => { try { const t=(await getStoreValue('productTypes')||[]).filter(x=>x!==req.params.name); await setStoreValue('productTypes',t); res.json(t); } catch(err) { res.status(500).json({error:err.message}); } });

app.get('/api/settings', async (req, res) => { try { res.json(await getStoreValue('settings')||{}); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/settings', requireAdmin, async (req, res) => { try { const u={...await getStoreValue('settings')||{},...req.body}; await setStoreValue('settings',u); res.json(u); } catch(err) { res.status(500).json({error:err.message}); } });

app.get('/api/orders', requireAdmin, async (req, res) => { try { res.json(await getStoreValue('orders')||[]); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/orders', async (req, res) => { try { const o={...req.body,timestamp:Date.now(),date:new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}; const orders=await getStoreValue('orders')||[]; orders.unshift(o); await setStoreValue('orders',orders); res.json(o); } catch(err) { res.status(500).json({error:err.message}); } });
app.delete('/api/orders/:timestamp', requireAdmin, async (req, res) => { try { const o=(await getStoreValue('orders')||[]).filter(x=>x.timestamp!==parseInt(req.params.timestamp)); await setStoreValue('orders',o); res.json({success:true}); } catch(err) { res.status(500).json({error:err.message}); } });

connectDB().then(() => app.listen(PORT, () => console.log(`Curled Macrame API :${PORT} | DB:${useDB?'MongoDB':'memory'} | Cloudinary:${CLOUDINARY_CONFIGURED}`)));
