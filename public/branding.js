// Branding: /images/logo.png and /images/bus.jpg. Falls back to text logo / CSS bus if a file is missing.
(function(){
  function probe(src,ok){var i=new Image();i.onload=function(){ok(src)};i.src=src;}
  probe('/images/logo.png',function(src){document.querySelectorAll('.brand').forEach(function(b){
    var m=b.querySelector('.brand-mark');if(!m)return;
    var img=document.createElement('img');img.src=src;img.alt='Krish Travels logo';img.className='brand-logo';
    b.replaceChild(img,m);b.classList.add('logo-on');});});
  probe('/images/bus.jpg',function(src){var h=document.querySelector('.hero-art');if(h){h.classList.add('has-photo');h.style.backgroundImage='url('+src+')';}});
})();
