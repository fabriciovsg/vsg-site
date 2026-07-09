document.addEventListener('DOMContentLoaded',function(){
  var nav=document.getElementById('nav');
  if(nav){
    window.addEventListener('scroll',function(){
      nav.classList.toggle('scrolled',window.scrollY>20);
    });
  }
  var burger=document.getElementById('navBurger');
  var panel=document.getElementById('navMobilePanel');
  if(burger&&panel){
    burger.addEventListener('click',function(){
      panel.classList.toggle('open');
    });
    panel.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click',function(){panel.classList.remove('open');});
    });
  }
});
