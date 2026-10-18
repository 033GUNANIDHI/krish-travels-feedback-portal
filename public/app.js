const $=(s,r=document)=>r.querySelector(s);
const form=$('#feedback-form'), result=$('#feedback-result');
let rating=0;
document.querySelectorAll('[data-rating]').forEach(btn=>btn.addEventListener('click',()=>{
  rating=Number(btn.dataset.rating);form.elements.rating.value=rating;
  document.querySelectorAll('[data-rating]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.rating)<=rating));
}));
form.addEventListener('submit',async e=>{
  e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent='Sending feedback…';
  const data=Object.fromEntries(new FormData(form).entries());
  try{
    const r=await fetch('/api/complaints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const out=await r.json();if(!r.ok)throw new Error(out.error||'Could not send feedback.');
    result.innerHTML=`<strong>Thank you for speaking up!</strong>${out.message}<br><strong style="margin-top:8px">Your ticket ID: ${out.ticketId}</strong><br>Please save this ID for future follow-up.`;
    result.classList.remove('hidden');form.reset();rating=0;document.querySelectorAll('[data-rating]').forEach(b=>b.classList.remove('selected'));
    result.scrollIntoView({behavior:'smooth',block:'center'});
  }catch(err){result.textContent=err.message;result.style.background='#fff0f0';result.style.color='#bd3e4b';result.classList.remove('hidden');}
  finally{button.disabled=false;button.innerHTML='Send feedback <span>↗</span>';}
});
$('#login-form').addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget,err=$('#login-error');err.textContent='';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f).entries()))});const d=await r.json();if(!r.ok)throw new Error(d.error);location.href='/dashboard.html';}
  catch(ex){err.textContent=ex.message||'Login failed. Please try again.';}
});
