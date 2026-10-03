import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import archiver from 'archiver';
import { neon } from '@neondatabase/serverless';
import { put, del } from '@vercel/blob';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({limit:'200kb'}));
app.use((_req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','strict-origin-when-cross-origin');res.set('X-Frame-Options','DENY');next();});
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024}});
const root = path.dirname(fileURLToPath(import.meta.url));
const hashToken = token => createHash('sha256').update(token).digest('hex');
const profileFromRow = row => row ? {...row,links:typeof row.links==='string'?JSON.parse(row.links):row.links} : null;
const sendError=(res,status,error)=>res.status(status).json({error});
const originOf=value=>{try{return new URL(value).origin}catch{return ''}};
const publicOrigin=originOf(process.env.PUBLIC_BASE_URL);
const profileUrl=slug=>`${(process.env.PUBLIC_BASE_URL||'http://localhost:5174').replace(/\/$/,'')}/profile/${encodeURIComponent(slug)}`;
const slugPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const loginAttempts=new Map();
let schemaPromise;

async function ensureSchema(){
 if(!sql) throw new Error('DATABASE_URL is not configured.');
 if(!schemaPromise) schemaPromise=(async()=>{
  await sql`CREATE TABLE IF NOT EXISTS admins (id BIGSERIAL PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,expires_at TIMESTAMPTZ NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS coordinators (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,photo TEXT,designation TEXT NOT NULL,department TEXT NOT NULL DEFAULT '',team_role TEXT NOT NULL DEFAULT '',society TEXT NOT NULL DEFAULT '',bio TEXT NOT NULL DEFAULT '',organization TEXT NOT NULL DEFAULT '',event TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',instagram TEXT NOT NULL DEFAULT '',linkedin TEXT NOT NULL DEFAULT '',links JSONB NOT NULL DEFAULT '[]'::jsonb,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS idx_coordinators_status ON coordinators(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_coordinators_name ON coordinators(name)`;
  const [seedMarker]=await sql`INSERT INTO app_metadata(key,value) VALUES('initial_seed','1') ON CONFLICT(key) DO NOTHING RETURNING key`;
  if(seedMarker) await sql`INSERT INTO coordinators(name,slug,photo,designation,department,team_role,society,bio,organization,event,email,phone,instagram,linkedin,links) VALUES(${'ABHINAV R'},${'arjun'},${'/demo-coordinator.png'},${'Lead Coordinator'},${''},${'DESIGN LEAD'},${'SPS Society'},${'Design Lead at IEEE SPS Society.'},${'IEEE'},${"VYORA'26"},${''},${'85903 20353'},${'https://www.instagram.com/achu_abhi05?stkn=MWJlZGxnZHZyemxlZA=='},${'https://www.linkedin.com/in/abhinav-r-651351357?utm_source=share_via&utm_content=profile&utm_medium=member_android'},${'[]'}::jsonb) ON CONFLICT(slug) DO NOTHING`;
  const [{adminCount}]=await sql`SELECT COUNT(*)::int AS "adminCount" FROM admins`;
  if(adminCount===0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD?.length>=12){
   const salt=randomBytes(16).toString('hex');
   const hash=`${salt}:${scryptSync(process.env.ADMIN_PASSWORD,salt,64).toString('hex')}`;
   await sql`INSERT INTO admins(email,password_hash) VALUES(${process.env.ADMIN_EMAIL.trim().toLowerCase()},${hash}) ON CONFLICT(email) DO NOTHING`;
  }
 })().catch(error=>{schemaPromise=null;throw error});
 return schemaPromise;
}

app.use('/api',async(req,res,next)=>{try{await ensureSchema();next()}catch(error){console.error(error);sendError(res,503,'Database is not configured or unavailable.')}});
app.use('/api/profiles',(req,res,next)=>{
 if(publicOrigin && req.headers.origin===publicOrigin){res.set('Access-Control-Allow-Origin',publicOrigin);res.set('Vary','Origin');res.set('Access-Control-Allow-Headers','Content-Type');res.set('Access-Control-Allow-Methods','GET, OPTIONS');}
 if(req.method==='OPTIONS')return res.sendStatus(204);
 next();
});
app.use('/api',(req,res,next)=>{
 if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
 const origin=req.headers.origin;
 const expected=process.env.ADMIN_BASE_URL?originOf(process.env.ADMIN_BASE_URL):`${req.protocol}://${req.get('host')}`;
 if(origin && origin!==expected && !(process.env.NODE_ENV!=='production' && origin==='http://localhost:5173'))return sendError(res,403,'Invalid request origin.');
 next();
});
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(part=>part.trim().split('=')).filter(parts=>parts.length===2));
async function adminFor(req){const token=cookies(req).sid;if(!token)return null;const rows=await sql`SELECT admins.id,admins.email FROM sessions JOIN admins ON admins.id=sessions.admin_id WHERE token_hash=${hashToken(token)} AND expires_at>now()`;return rows[0]||null;}
const requireAdmin=async(req,res,next)=>{try{const admin=await adminFor(req);if(!admin)return sendError(res,401,'Admin sign in required.');req.admin=admin;next()}catch(nextError){next(nextError)}};
const validUrl=value=>!value||(typeof value==='string'&&/^https?:\/\//i.test(value)&&(()=>{try{return ['http:','https:'].includes(new URL(value).protocol)}catch{return false}})());
function cleanProfile(body){
 const trim=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';
 const p={name:trim(body.name,100),slug:trim(body.slug,80).toLowerCase(),designation:trim(body.designation,100),department:trim(body.department,100),team_role:trim(body.team_role,100),society:trim(body.society,120),bio:trim(body.bio,600),organization:trim(body.organization,120),event:trim(body.event,120),email:trim(body.email,160),phone:trim(body.phone,50),instagram:trim(body.instagram,300),linkedin:trim(body.linkedin,300),status:body.status==='inactive'?'inactive':'active',links:Array.isArray(body.links)?body.links.slice(0,12).map(x=>({label:trim(x.label,80),url:trim(x.url,300)})).filter(x=>x.label&&x.url):[]};
 if(!p.name||!p.designation||!slugPattern.test(p.slug))throw new Error('Name, designation, and a lowercase URL slug are required.');
 if(p.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email))throw new Error('Enter a valid email address.');
 if(![p.instagram,p.linkedin,...p.links.map(x=>x.url)].every(validUrl))throw new Error('Social and custom links must start with http:// or https://.');
 return p;
}

app.get('/api/health',(_req,res)=>res.json({ok:true}));
app.post('/api/auth/login',async(req,res,next)=>{try{
 const ip=req.ip,attempt=loginAttempts.get(ip);
 if(attempt?.until>Date.now()&&attempt.count>=8)return sendError(res,429,'Too many sign-in attempts. Try again later.');
 const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
 const [admin]=await sql`SELECT * FROM admins WHERE email=${email}`;
 const dummy='00000000000000000000000000000000';
 const [salt,stored]=admin?.password_hash.split(':')||[dummy,scryptSync('unused',dummy,64).toString('hex')];
 const actual=scryptSync(password,salt,64);
 if(!admin||!timingSafeEqual(actual,Buffer.from(stored,'hex'))){loginAttempts.set(ip,{count:(attempt?.until>Date.now()?attempt.count:0)+1,until:Date.now()+15*60*1000});return sendError(res,401,'Invalid email or password.');}
 loginAttempts.delete(ip);
 const token=randomBytes(32).toString('hex'),expires=Date.now()+7*24*60*60*1000;
 await sql`INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(${hashToken(token)},${admin.id},to_timestamp(${expires/1000}))`;
 res.cookie('sid',token,{httpOnly:true,sameSite:'strict',secure:!!process.env.VERCEL||process.env.NODE_ENV==='production',path:'/',maxAge:7*24*60*60*1000});
 res.json({email:admin.email});
}catch(error){next(error)}});
app.get('/api/auth/me',async(req,res,next)=>{try{const admin=await adminFor(req);if(!admin)return sendError(res,401,'Not signed in.');res.json(admin)}catch(error){next(error)}});
app.post('/api/auth/logout',requireAdmin,async(req,res,next)=>{try{await sql`DELETE FROM sessions WHERE token_hash=${hashToken(cookies(req).sid)}`;res.clearCookie('sid',{path:'/'});res.json({ok:true})}catch(error){next(error)}});

app.get('/api/profiles/:slug',async(req,res,next)=>{try{const [row]=await sql`SELECT * FROM coordinators WHERE slug=${req.params.slug} AND status='active'`;if(!row)return sendError(res,404,'Profile not found.');res.json({profile:profileFromRow(row),url:profileUrl(row.slug)})}catch(error){next(error)}});
app.get('/api/profiles/:slug/qr',async(req,res,next)=>{try{const [row]=await sql`SELECT slug FROM coordinators WHERE slug=${req.params.slug} AND status='active'`;if(!row)return sendError(res,404,'Profile not found.');res.type('png');res.send(await QRCode.toBuffer(profileUrl(row.slug),{width:600,margin:2}))}catch(error){next(error)}});
app.get('/api/admin/profiles',requireAdmin,async(req,res,next)=>{try{
 const search=String(req.query.search||'').slice(0,100),pattern=`%${search}%`,status=['active','inactive'].includes(req.query.status)?req.query.status:'',page=Math.max(1,Number.parseInt(req.query.page,10)||1),limit=20,offset=(page-1)*limit;
 const [{n}]=await sql`SELECT COUNT(*)::int AS n FROM coordinators WHERE (${status}='' OR status=${status}) AND (${search}='' OR name ILIKE ${pattern} OR slug ILIKE ${pattern} OR department ILIKE ${pattern} OR team_role ILIKE ${pattern} OR society ILIKE ${pattern})`;
 const rows=await sql`SELECT * FROM coordinators WHERE (${status}='' OR status=${status}) AND (${search}='' OR name ILIKE ${pattern} OR slug ILIKE ${pattern} OR department ILIKE ${pattern} OR team_role ILIKE ${pattern} OR society ILIKE ${pattern}) ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`;
 res.json({items:rows.map(profileFromRow),total:n,page,pages:Math.max(1,Math.ceil(n/limit))});
}catch(error){next(error)}});
app.post('/api/admin/profiles',requireAdmin,async(req,res,next)=>{try{
 const p=cleanProfile(req.body);
 const [row]=await sql`INSERT INTO coordinators(name,slug,designation,department,team_role,society,bio,organization,event,email,phone,instagram,linkedin,links,status) VALUES(${p.name},${p.slug},${p.designation},${p.department},${p.team_role},${p.society},${p.bio},${p.organization},${p.event},${p.email},${p.phone},${p.instagram},${p.linkedin},${JSON.stringify(p.links)}::jsonb,${p.status}) RETURNING *`;
 res.status(201).json({profile:profileFromRow(row)});
}catch(error){if(error.code==='23505')return sendError(res,409,'That slug is already in use.');if(error.message?.startsWith('Name,')||error.message?.startsWith('Enter')||error.message?.startsWith('Social'))return sendError(res,400,error.message);next(error)}});
app.put('/api/admin/profiles/:id',requireAdmin,async(req,res,next)=>{try{
 const p=cleanProfile(req.body);
 const [row]=await sql`UPDATE coordinators SET name=${p.name},slug=${p.slug},designation=${p.designation},department=${p.department},team_role=${p.team_role},society=${p.society},bio=${p.bio},organization=${p.organization},event=${p.event},email=${p.email},phone=${p.phone},instagram=${p.instagram},linkedin=${p.linkedin},links=${JSON.stringify(p.links)}::jsonb,status=${p.status},updated_at=now() WHERE id=${req.params.id} RETURNING *`;
 if(!row)return sendError(res,404,'Profile not found.');res.json({profile:profileFromRow(row)});
}catch(error){if(error.code==='23505')return sendError(res,409,'That slug is already in use.');if(error.message?.startsWith('Name,')||error.message?.startsWith('Enter')||error.message?.startsWith('Social'))return sendError(res,400,error.message);next(error)}});
app.patch('/api/admin/profiles/:id/status',requireAdmin,async(req,res,next)=>{try{if(!['active','inactive'].includes(req.body.status))return sendError(res,400,'Invalid status.');const [row]=await sql`UPDATE coordinators SET status=${req.body.status},updated_at=now() WHERE id=${req.params.id} RETURNING id`;if(!row)return sendError(res,404,'Profile not found.');res.json({ok:true})}catch(error){next(error)}});
app.delete('/api/admin/profiles/:id',requireAdmin,async(req,res,next)=>{try{const [row]=await sql`DELETE FROM coordinators WHERE id=${req.params.id} RETURNING photo`;if(!row)return sendError(res,404,'Profile not found.');if(row.photo?.startsWith('https://'))del(row.photo).catch(console.error);res.json({ok:true})}catch(error){next(error)}});
app.post('/api/admin/profiles/:id/photo',requireAdmin,upload.single('photo'),async(req,res,next)=>{try{
 if(!req.file)return sendError(res,400,'Choose an image.');
 if(!process.env.BLOB_READ_WRITE_TOKEN)return sendError(res,503,'Image storage is not configured.');
 const [row]=await sql`SELECT id,photo FROM coordinators WHERE id=${req.params.id}`;if(!row)return sendError(res,404,'Profile not found.');
 const image=await sharp(req.file.buffer,{failOn:'error'}).rotate().resize(1200,1200,{fit:'cover',withoutEnlargement:true}).webp({quality:84}).toBuffer();
 const filename=`coordinators/${row.id}-${Date.now()}-${randomBytes(4).toString('hex')}.webp`;
 const blob=await put(filename,image,{access:'public',contentType:'image/webp'});
 await sql`UPDATE coordinators SET photo=${blob.url},updated_at=now() WHERE id=${row.id}`;
 if(row.photo?.startsWith('https://'))del(row.photo).catch(console.error);
 res.json({photo:blob.url});
}catch(error){if(error.message?.includes('Input buffer'))return sendError(res,400,'The uploaded file is not a supported image.');next(error)}});
app.get('/api/admin/profiles/:id/qr',requireAdmin,async(req,res,next)=>{try{const [row]=await sql`SELECT slug FROM coordinators WHERE id=${req.params.id}`;if(!row)return sendError(res,404,'Profile not found.');res.type('png');res.set('Content-Disposition',`attachment; filename="${row.slug}-qr.png"`);res.send(await QRCode.toBuffer(profileUrl(row.slug),{width:900,margin:2}))}catch(error){next(error)}});
app.get('/api/admin/qr-all',requireAdmin,async(req,res,next)=>{try{const rows=await sql`SELECT slug FROM coordinators WHERE status='active' ORDER BY slug`;res.type('zip');res.set('Content-Disposition','attachment; filename="coordinator-qr-codes.zip"');const archive=archiver('zip',{zlib:{level:6}});archive.on('error',next);archive.pipe(res);for(const row of rows)archive.append(await QRCode.toBuffer(profileUrl(row.slug),{width:900,margin:2}),{name:`${row.slug}-qr.png`});await archive.finalize()}catch(error){next(error)}});

app.use(express.static(path.join(root,'public')));
app.get('/{*path}',(_req,res)=>res.sendFile(path.join(root,'public','index.html')));
app.use((error,_req,res,_next)=>{console.error(error);if(error instanceof multer.MulterError)return sendError(res,400,error.code==='LIMIT_FILE_SIZE'?'Image must be under 5 MB.':error.message);if(!res.headersSent)sendError(res,500,'Something went wrong.')});
if(!process.env.VERCEL){const port=Number(process.env.PORT||3001);app.listen(port,()=>console.log(`Admin API ready on http://localhost:${port}`));}
export default app;
