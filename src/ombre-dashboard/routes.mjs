const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};

export function createOmbreDashboardRoutes(service){
  return async function route(req,res){
    if(req.method!=='GET')return false;
    const url=new URL(req.url,'http://localhost');
    try{
      if(url.pathname==='/api/ombre-dashboard/status'){send(res,200,await service.status());return true}
      if(url.pathname==='/api/ombre-dashboard/buckets'){send(res,200,{items:await service.buckets()});return true}
      if(url.pathname==='/api/ombre-dashboard/search'){send(res,200,{items:await service.search(url.searchParams.get('q')||'')});return true}
      if(url.pathname==='/api/ombre-dashboard/breath-debug'){send(res,200,await service.breathDebug(url.searchParams.get('q')||''));return true}
      const match=url.pathname.match(/^\/api\/ombre-dashboard\/buckets\/([^/]+)$/);
      if(match){send(res,200,await service.bucket(decodeURIComponent(match[1])));return true}
      return false;
    }catch(error){
      const code=['ombre_not_configured','ombre_auth_failed','ombre_unavailable','ombre_upstream_error'].includes(error?.code)?error.code:'ombre_upstream_error';
      send(res,error?.statusCode||502,{error:code});return true;
    }
  };
}
