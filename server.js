require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/';
const DB_NAME = process.env.MONGODB_DB || 'krish_travels_feedback';
let db, users, complaints, auditLogs;

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(require('path').join(__dirname, 'public')));

const clean = (v, max=500) => String(v ?? '').trim().slice(0, max);
const safeUser = u => ({ id:u.id, username:u.username, name:u.name, role:u.role, active:u.active, createdAt:u.createdAt });
const dateStart = d => new Date(d.getFullYear(),d.getMonth(),d.getDate());
const weekStart = d => { const x=dateStart(d); x.setDate(x.getDate()-(x.getDay()+6)%7); return x; };
const sameDay = (iso,d) => { const x=new Date(iso); return x.getFullYear()===d.getFullYear()&&x.getMonth()===d.getMonth()&&x.getDate()===d.getDate(); };
const CATEGORIES=['Bus delay','Staff behaviour','Booking / ticket','Bus condition','Boarding / seat','Payment / refund','Tracking / app','Other'];
const ymd=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const isDone=c=>['Resolved','Closed'].includes(c.status);
const topCats=(list,n=5)=>{const m={};list.forEach(c=>m[c.category]=(m[c.category]||0)+1);return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([category,count])=>({category,count}));};
const cell=v=>{let t=String(v??'').replace(/\r?\n/g,' ');if(/^[=+\-@\t]/.test(t))t="'"+t;return t;};
const csvLine=r=>r.map(v=>'"'+cell(v).replace(/"/g,'""')+'"').join(',');
const xmlEsc=v=>cell(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const xmlSheet=(name,rows)=>`<Worksheet ss:Name="${name}"><Table>${rows.map(r=>`<Row>${r.map(v=>typeof v==='number'?`<Cell><Data ss:Type="Number">${v}</Data></Cell>`:`<Cell><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet>`;
function newComplaint(b,source,createdBy){
  const name=clean(b.name,100),category=clean(b.category,60),message=clean(b.message,2500);
  if(!name||!category||!message) return {error:'Name, category and complaint details are required.'};
  if(!CATEGORIES.includes(category)) return {error:'Choose a valid category.'};
  const now=new Date().toISOString();
  return {c:{id:'KT-'+now.slice(2,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase(),
    name,phone:clean(b.phone,30),email:clean(b.email,120),category,subject:clean(b.subject,140),message,
    rating:Math.max(0,Math.min(5,Number(b.rating)||0)),busNumber:clean(b.busNumber,40),travelDate:clean(b.travelDate,20),
    status:'New',priority:['Low','Normal','High','Urgent'].includes(b.priority)?b.priority:'Normal',assignedTo:'',staffNote:'',createdAt:now,updatedAt:now,source,createdBy,resolution:''}};
}
function buildReport(all,period){
  const now=new Date(),B=[];
  if(period==='day') for(let i=29;i>=0;i--){const s=dateStart(now);s.setDate(s.getDate()-i);const e=new Date(s);e.setDate(e.getDate()+1);B.push({label:ymd(s),s,e});}
  else if(period==='week') for(let i=11;i>=0;i--){const s=weekStart(now);s.setDate(s.getDate()-7*i);const e=new Date(s);e.setDate(e.getDate()+7);const l=new Date(s);l.setDate(l.getDate()+6);B.push({label:ymd(s)+' to '+ymd(l),s,e});}
  else for(let i=11;i>=0;i--){const s=new Date(now.getFullYear(),now.getMonth()-i,1);B.push({label:s.toLocaleDateString('en-IN',{month:'short',year:'numeric'}),s,e:new Date(s.getFullYear(),s.getMonth()+1,1)});}
  const inWin=all.filter(c=>{const t=new Date(c.createdAt);return t>=B[0].s&&t<B[B.length-1].e;});
  const rows=B.map(b=>{const l=inWin.filter(c=>{const t=new Date(c.createdAt);return t>=b.s&&t<b.e;}),r=l.filter(c=>c.rating>0);
    return {label:b.label,total:l.length,resolved:l.filter(isDone).length,open:l.filter(c=>!isDone(c)).length,urgent:l.filter(c=>c.priority==='Urgent').length,avgRating:r.length?Number((r.reduce((x,c)=>x+c.rating,0)/r.length).toFixed(1)):0,topCategory:(topCats(l,1)[0]||{}).category||'-'};});
  return {period,from:ymd(B[0].s),to:ymd(new Date(B[B.length-1].e.getTime()-1)),rows,byCategory:topCats(inWin,20),total:inWin.length,complaints:inWin};
}
async function audit(actor, action, detail='') {
  await auditLogs.insertOne({ id:crypto.randomUUID(), actor, action, detail, at:new Date().toISOString() });
  const count=await auditLogs.countDocuments();
  if(count>500) {
    const old=await auditLogs.find({}, {projection:{_id:1}}).sort({at:1}).limit(count-500).toArray();
    if(old.length) await auditLogs.deleteMany({_id:{$in:old.map(x=>x._id)}});
  }
}
function auth(req,res,next) {
  const token=req.cookies.kt_session;
  if(!token) return res.status(401).json({error:'Please log in.'});
  try { const payload=jwt.verify(token,SECRET); req.authId=payload.id; next(); }
  catch { return res.status(401).json({error:'Session expired. Please log in again.'}); }
}
async function loadUser(req,res,next) {
  try {
    req.user=await users.findOne({id:req.authId,active:true});
    if(!req.user) return res.status(401).json({error:'Account unavailable. Contact admin.'});
    next();
  } catch { res.status(500).json({error:'Unable to verify account.'}); }
}
const adminOnly=(req,res,next)=>req.user?.role==='admin'?next():res.status(403).json({error:'Admin access required.'});
const staffOrAdmin=(req,res,next)=>['staff','admin'].includes(req.user?.role)?next():res.status(403).json({error:'Staff access required.'});
const protect=[auth,loadUser];

app.get('/api/health',(req,res)=>res.json({ok:true,app:'Krish Travels Support Portal',database:'MongoDB'}));
app.post('/api/login',async(req,res)=>{
  try {
    const username=clean(req.body.username,80).toLowerCase(), password=String(req.body.password||''), requestedRole=clean(req.body.role,20);
    if(!['staff','admin'].includes(requestedRole)) return res.status(400).json({error:'Choose Staff login or Admin login.'});
    const user=await users.findOne({username,active:true,role:requestedRole});
    if(!user || !(await bcrypt.compare(password,user.passwordHash))) return res.status(401).json({error:'Username or password is incorrect.'});
    const token=jwt.sign({id:user.id},SECRET,{expiresIn:'8h'});
    res.cookie('kt_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000});
    await audit(user.username,'Login',user.role);
    res.json({user:safeUser(user),mustChangePassword:!!user.mustChangePassword});
  } catch(e){ console.error(e); res.status(500).json({error:'Login is temporarily unavailable.'}); }
});
app.post('/api/logout',(req,res)=>{res.clearCookie('kt_session',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'});res.json({ok:true});});
app.get('/api/me',...protect,(req,res)=>res.json({user:safeUser(req.user),mustChangePassword:!!req.user.mustChangePassword}));
app.post('/api/change-password',...protect,async(req,res)=>{
  const current=String(req.body.currentPassword||''), next=String(req.body.newPassword||'');
  if(next.length<10) return res.status(400).json({error:'New password must be at least 10 characters.'});
  if(!(await bcrypt.compare(current,req.user.passwordHash))) return res.status(400).json({error:'Current password is incorrect.'});
  await users.updateOne({id:req.user.id},{$set:{passwordHash:await bcrypt.hash(next,12),mustChangePassword:false}});
  await audit(req.user.username,'Password changed'); res.json({ok:true});
});
app.post('/api/complaints',async(req,res)=>{
  const r=newComplaint(req.body||{},'Passenger form','Passenger');
  if(r.error) return res.status(400).json({error:r.error});
  r.c.priority='Normal'; await complaints.insertOne(r.c); await audit('Passenger','New complaint',r.c.id);
  res.status(201).json({ok:true,ticketId:r.c.id,message:'Your feedback has been received. Save your ticket ID for reference.'});
});
app.post('/api/staff-complaints',...protect,staffOrAdmin,async(req,res)=>{
  const r=newComplaint(req.body||{},'Staff entry',req.user.username);
  if(r.error) return res.status(400).json({error:r.error});
  await complaints.insertOne(r.c); await audit(req.user.username,'Staff registered complaint',r.c.id);
  const {_id,...out}=r.c; res.status(201).json({ok:true,ticketId:r.c.id,complaint:out});
});
app.get('/api/dashboard',...protect,staffOrAdmin,async(req,res)=>{
  const all=await complaints.find({},{projection:{_id:0}}).sort({createdAt:-1}).toArray();
  const now=new Date(), start=dateStart(now), ws=weekStart(now), today=all.filter(c=>new Date(c.createdAt)>=start), week=all.filter(c=>new Date(c.createdAt)>=ws);
  const open=all.filter(c=>!['Resolved','Closed'].includes(c.status)),byStatus={},byCategory={},daily=[];
  for(const c of all) byStatus[c.status]=(byStatus[c.status]||0)+1;
  for(const c of all) byCategory[c.category]=(byCategory[c.category]||0)+1;
  for(let i=6;i>=0;i--){const d=new Date(start);d.setDate(d.getDate()-i);daily.push({date:d.toISOString().slice(0,10),label:d.toLocaleDateString('en-IN',{weekday:'short'}),count:all.filter(c=>sameDay(c.createdAt,d)).length});}
  const rated=all.filter(c=>c.rating>0);
  res.json({stats:{total:all.length,today:today.length,thisWeek:week.length,open:open.length,urgent:all.filter(c=>c.priority==='Urgent'&&!['Resolved','Closed'].includes(c.status)).length,resolved:all.filter(c=>['Resolved','Closed'].includes(c.status)).length,avgRating:rated.length?Number((rated.reduce((s,c)=>s+c.rating,0)/rated.length).toFixed(1)):0},byStatus,byCategory,daily,topWeek:topCats(week,5),recent:all.slice(0,8)});
});
app.get('/api/complaints',...protect,staffOrAdmin,async(req,res)=>{
  const q=clean(req.query.q,100).toLowerCase(),status=clean(req.query.status,40),range=clean(req.query.range,20),source=clean(req.query.source,30);
  let list=await complaints.find({},{projection:{_id:0}}).sort({createdAt:-1}).toArray();
  const now=new Date();let cutoff=null;if(range==='today')cutoff=dateStart(now);if(range==='week')cutoff=weekStart(now);if(range==='month')cutoff=new Date(now.getFullYear(),now.getMonth(),1);
  if(cutoff)list=list.filter(c=>new Date(c.createdAt)>=cutoff);
  if(status&&status!=='All')list=list.filter(c=>c.status===status);
  if(source&&source!=='All')list=list.filter(c=>c.source===source);
  if(q)list=list.filter(c=>[c.id,c.name,c.phone,c.email,c.category,c.subject,c.busNumber,c.message,c.assignedTo,c.createdBy].join(' ').toLowerCase().includes(q));
  res.json({complaints:list});
});
app.patch('/api/complaints/:id',...protect,staffOrAdmin,async(req,res)=>{
  const c=await complaints.findOne({id:req.params.id});if(!c)return res.status(404).json({error:'Complaint not found.'});
  const b=req.body||{},set={updatedAt:new Date().toISOString()};
  if(b.status!==undefined){if(!['New','In Progress','Waiting for Customer','Resolved','Closed'].includes(b.status))return res.status(400).json({error:'Invalid status.'});set.status=b.status;}
  if(b.priority!==undefined){if(!['Low','Normal','High','Urgent'].includes(b.priority))return res.status(400).json({error:'Invalid priority.'});set.priority=b.priority;}
  if(b.assignedTo!==undefined)set.assignedTo=clean(b.assignedTo,100);
  if(b.staffNote!==undefined)set.staffNote=clean(b.staffNote,2000);
  if(b.resolution!==undefined)set.resolution=clean(b.resolution,2000);
  await complaints.updateOne({id:c.id},{$set:set});await audit(req.user.username,'Updated complaint',c.id);
  res.json({complaint:{...c,...set}});
});
app.get('/api/staff',...protect,adminOnly,async(req,res)=>{
  const list=await users.find({role:'staff'},{projection:{_id:0,passwordHash:0,mustChangePassword:0}}).sort({createdAt:-1}).toArray();
  res.json({staff:list.map(s=>({...s,lastLogin:s.lastLogin||null}))});
});
app.post('/api/staff',...protect,adminOnly,async(req,res)=>{
  const username=clean(req.body.username,60).toLowerCase(),name=clean(req.body.name,100),password=String(req.body.password||'');
  if(!/^[a-z0-9._-]{3,60}$/.test(username))return res.status(400).json({error:'Username: use 3–60 lowercase letters, numbers, dots, underscores or hyphens.'});
  if(name.length<2)return res.status(400).json({error:'Enter the staff member name.'});
  if(password.length<10)return res.status(400).json({error:'Temporary password must be at least 10 characters.'});
  if(await users.findOne({username}))return res.status(409).json({error:'Username already exists.'});
  const u={id:crypto.randomUUID(),username,name,passwordHash:await bcrypt.hash(password,12),role:'staff',active:true,createdAt:new Date().toISOString(),mustChangePassword:true};
  await users.insertOne(u);await audit(req.user.username,'Created staff account',username);res.status(201).json({staff:safeUser(u)});
});
app.patch('/api/staff/:id',...protect,adminOnly,async(req,res)=>{
  const u=await users.findOne({id:req.params.id,role:'staff'});if(!u)return res.status(404).json({error:'Staff account not found.'});
  const set={};
  if(typeof req.body.active==='boolean')set.active=req.body.active;
  if(req.body.newPassword){if(String(req.body.newPassword).length<10)return res.status(400).json({error:'Password must be at least 10 characters.'});set.passwordHash=await bcrypt.hash(String(req.body.newPassword),12);set.mustChangePassword=true;}
  if(!Object.keys(set).length)return res.status(400).json({error:'No valid account changes supplied.'});
  await users.updateOne({id:u.id},{$set:set});await audit(req.user.username,'Updated staff account',u.username);res.json({staff:safeUser({...u,...set})});
});
app.get('/api/export.csv',...protect,adminOnly,async(req,res)=>{
  const all=await complaints.find({},{projection:{_id:0}}).sort({createdAt:-1}).toArray();
  const cols=['id','createdAt','name','phone','email','category','subject','busNumber','travelDate','rating','status','priority','assignedTo','message','staffNote','resolution','source','createdBy'];
  const csvEsc=v=>'"'+cell(v).replace(/"/g,'""')+'"';
  res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="krish-travels-complaints.csv"');
  res.send('\uFEFF'+[cols.join(','),...all.map(c=>cols.map(k=>csvEsc(c[k])).join(','))].join('\r\n'));
});
app.get('/api/reports',...protect,staffOrAdmin,async(req,res)=>{
  const period=['day','week','month'].includes(req.query.period)?req.query.period:'day';
  const all=await complaints.find({},{projection:{_id:0}}).sort({createdAt:-1}).toArray();
  const rep=buildReport(all,period); delete rep.complaints; res.json(rep);
});
app.get('/api/reports/export',...protect,staffOrAdmin,async(req,res)=>{
  const period=['day','week','month'].includes(req.query.period)?req.query.period:'day', fmt=req.query.format==='xls'?'xls':'csv';
  const all=await complaints.find({},{projection:{_id:0}}).sort({createdAt:-1}).toArray();
  const r=buildReport(all,period), name={day:'Day-wise',week:'Weekly',month:'Monthly'}[period];
  const sum=[[name+' report',r.from+' to '+r.to],['Period','Total','Resolved/Closed','Open','Urgent','Avg rating','Top category'],...r.rows.map(x=>[x.label,x.total,x.resolved,x.open,x.urgent,x.avgRating,x.topCategory])];
  const cat=[['Category','Complaints'],...r.byCategory.map(x=>[x.category,x.count])];
  const cols=['id','createdAt','source','createdBy','name','phone','email','category','subject','busNumber','travelDate','rating','status','priority','assignedTo','message','staffNote','resolution'];
  const det=[cols,...r.complaints.map(c=>cols.map(k=>c[k]??''))];
  const file=`krish-travels-${period}-report-${ymd(new Date())}.${fmt}`;
  res.setHeader('Content-Disposition',`attachment; filename="${file}"`);
  if(fmt==='csv'){res.setHeader('Content-Type','text/csv; charset=utf-8');return res.send('\uFEFF'+[...sum,[],...cat,[],...det].map(csvLine).join('\r\n'));}
  res.setHeader('Content-Type','application/vnd.ms-excel; charset=utf-8');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'+xmlSheet('Summary',sum)+xmlSheet('Categories',cat)+xmlSheet('Complaints',det)+'</Workbook>');
});
app.get('/api/audit',...protect,adminOnly,async(req,res)=>res.json({audit:await auditLogs.find({},{projection:{_id:0}}).sort({at:-1}).limit(100).toArray()}));
app.use('/api',(err,req,res,next)=>{console.error(err);res.status(500).json({error:'Something went wrong. Please try again.'});});

async function main(){
  if(!SECRET||SECRET.length<32)throw new Error('Set JWT_SECRET to a random secret of at least 32 characters in .env');
  const client=new MongoClient(MONGO_URI);await client.connect();db=client.db(DB_NAME);
  users=db.collection('users');complaints=db.collection('complaints');auditLogs=db.collection('audit');
  await users.createIndex({username:1},{unique:true});await complaints.createIndex({id:1},{unique:true});await auditLogs.createIndex({at:-1});
  if(!await users.findOne({role:'admin'})){
    const username=clean(process.env.ADMIN_USERNAME||'admin',60).toLowerCase();
    const password=process.env.ADMIN_PASSWORD;
    if(!password||password.length<10)throw new Error('Set ADMIN_PASSWORD (at least 10 characters) in .env before first run.');
    await users.insertOne({id:crypto.randomUUID(),username,name:'Krish Travels Admin',passwordHash:await bcrypt.hash(password,12),role:'admin',active:true,createdAt:new Date().toISOString(),mustChangePassword:true});
    await audit('system','Admin account initialized',username);console.log('Initial admin account created; change password after login.');
  }
  app.listen(PORT,()=>console.log(`Krish Travels portal running at http://localhost:${PORT}; MongoDB database: ${DB_NAME}`));
}
main().catch(e=>{console.error('Startup failed:',e.message);process.exit(1);});
