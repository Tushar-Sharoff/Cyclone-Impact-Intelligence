const $=s=>document.querySelector(s),S={active:new Set(["track","forecast","risk"])};
const log=(stage,error)=>console.error("[Cyclone Command Center]",stage,error instanceof Error?error.message:error);
window.addEventListener("error", event => log("runtime", event.error || event.message));
window.addEventListener("unhandledrejection", event => log("unhandled promise", event.reason));
const colour={rainfall:"#377eff",elevation:"#52c889",population:"#b591ff"},band={low:"#56d7a8",medium:"#f5c451",high:"#ff6270"};
const get=async(p,o={})=>{const r=await fetch(p,o),j=await r.json().catch(()=>({error:"Unreadable response"}));if(!r.ok)throw Error(j.error||r.status);return j};
const cyclone=$("#cyclone"),time=$("#risk-time"),map=$("#map"),event=()=>JSON.parse(cyclone.selectedOptions[0].dataset.event),points=()=>S.track.features.filter(f=>f.geometry.type==="Point"),locationData=id=>S.locations.features.find(f=>f.properties.location_id===id)?.properties,risk=id=>S.risk.features.find(f=>f.properties.location_id===id)?.properties,kind=s=>s==="forecast"?"predicted":"observed",label=s=>kind(s).toUpperCase();

let googleMapsReady = false;
let gMap = null;
let gOverlays = [];
let scenarioMaps = [];

const darkMapStyles = [
  { elementType: "geometry", stylers: [{ color: "#091728" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#07111f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8ca3ba" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#cbd8e9" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#142942" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#546e8c" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#050e1a" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3e5d7d" }] }
];

async function initGoogleMaps() {
  try {
    const cfg = await get("/map-config");
    if (cfg.google_maps_api_key) {
      await new Promise((resolve) => {
        if (window.google?.maps) {
          googleMapsReady = true;
          return resolve();
        }
        window.gm_authFailure = () => {
          console.warn("[Cyclone Command Center] Google Maps authentication failed; using coordinate fallback.");
          googleMapsReady = false;
          drawFallback();
        };
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.google_maps_api_key)}`;
        s.async = true;
        s.onload = () => {
          googleMapsReady = true;
          resolve();
        };
        s.onerror = (e) => {
          console.warn("[Cyclone Command Center] Google Maps failed to load; using coordinate fallback:", e);
          googleMapsReady = false;
          resolve();
        };
        document.head.appendChild(s);
      });
      googleMapsReady = Boolean(window.google?.maps);
    }
  } catch (err) {
    log("map-config", err);
  }
}

document.querySelectorAll(".nav button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${b.dataset.page}`));
  document.querySelectorAll(".nav button").forEach(x=>x.classList.toggle("active",x===b));
  if(b.dataset.page==="map"){
    setTimeout(()=>{
      if(gMap && window.google?.maps) google.maps.event.trigger(gMap, "resize");
      draw();
    },50);
  } else if(b.dataset.page==="simulation"){
    setTimeout(()=>{
      if(window.google?.maps && scenarioMaps.length) {
        scenarioMaps.forEach(m => m && google.maps.event.trigger(m, "resize"));
      }
    },50);
  }
  window.scrollTo({top:0,behavior:"smooth"});
});

function geometry(){
  const a=[...points().map(f=>f.geometry.coordinates),...S.forecast.map(f=>[f.longitude,f.latitude]),...S.locations.features.flatMap(f=>f.geometry.coordinates[0])],xs=a.map(v=>v[0]),ys=a.map(v=>v[1]),minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys),w=1000,h=570,pad=42;
  return{x:v=>pad+(v-minx)/(maxx-minx||1)*(w-2*pad),y:v=>h-(pad+(v-miny)/(maxy-miny||1)*(h-2*pad)),w,h};
}
function shape(l,g){return l.geometry.coordinates[0].map(v=>`${g.x(v[0])},${g.y(v[1])}`).join(" ")}

function drawGoogleMap() {
  if (!S.track) return;
  const obs = points().map(f => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
  if (!gMap) {
    map.innerHTML = "";
    gMap = new google.maps.Map(map, {
      zoom: 6,
      center: obs.length ? obs[obs.length - 1] : { lat: 19.0, lng: 85.0 },
      styles: darkMapStyles,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });
  }
  gOverlays.forEach(o => o.setMap(null));
  gOverlays = [];
  const bounds = new google.maps.LatLngBounds();

  if (S.locations?.features) {
    S.locations.features.forEach(l => {
      const paths = l.geometry.coordinates[0].map(([lng, lat]) => {
        bounds.extend({ lat, lng });
        return { lat, lng };
      });
      S.layers.filter(x => S.active.has(x.layer_id)).forEach(x => {
        const poly = new google.maps.Polygon({
          paths,
          map: gMap,
          fillColor: colour[x.layer_id] || "#377eff",
          fillOpacity: 0.14,
          strokeColor: colour[x.layer_id] || "#377eff",
          strokeWeight: 1,
          zIndex: 2,
        });
        gOverlays.push(poly);
      });
    });
  }

  if (S.active.has("risk") && S.locations?.features && S.risk?.features) {
    S.locations.features.forEach(l => {
      const r = risk(l.properties.location_id);
      if (!r) return;
      const paths = l.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
      const col = band[r.band] || "#ff6270";
      const poly = new google.maps.Polygon({
        paths,
        map: gMap,
        fillColor: col,
        fillOpacity: 0.44,
        strokeColor: col,
        strokeWeight: 2,
        clickable: true,
        zIndex: 5,
      });
      poly.addListener("click", () => showLocation(r.location_id));
      gOverlays.push(poly);
    });
  }

  if (S.active.has("track") && obs.length > 0) {
    const line = new google.maps.Polyline({
      path: obs,
      map: gMap,
      strokeColor: "#ff6270",
      strokeWeight: 4,
      strokeOpacity: 0.95,
      zIndex: 10,
    });
    gOverlays.push(line);
    obs.forEach(p => {
      bounds.extend(p);
      const marker = new google.maps.Circle({
        center: p,
        map: gMap,
        radius: 8000,
        fillColor: "#ff6270",
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 1.5,
        zIndex: 11,
      });
      gOverlays.push(marker);
    });
  }

  if (S.active.has("forecast") && S.forecast?.length > 0) {
    const lastObs = obs.length ? obs[obs.length - 1] : null;
    const fcPoints = [lastObs, ...S.forecast.map(p => ({ lat: p.latitude, lng: p.longitude }))].filter(Boolean);
    const fcLine = new google.maps.Polyline({
      path: fcPoints,
      map: gMap,
      strokeColor: "#b591ff",
      strokeOpacity: 0,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "14px" }],
      zIndex: 8,
    });
    gOverlays.push(fcLine);
    S.forecast.forEach(p => {
      const pt = { lat: p.latitude, lng: p.longitude };
      bounds.extend(pt);
      const marker = new google.maps.Circle({
        center: pt,
        map: gMap,
        radius: 7000,
        fillColor: "#b591ff",
        fillOpacity: 0.9,
        strokeColor: "#ffffff",
        strokeWeight: 1,
        zIndex: 9,
      });
      gOverlays.push(marker);
    });
  }

  if (!bounds.isEmpty()) {
    gMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
  }
}

function drawFallback(){
  gMap = null;
  const g=geometry(),o=points(),path=o.map(f=>`${g.x(f.geometry.coordinates[0])},${g.y(f.geometry.coordinates[1])}`).join(" "),pred=[...o.slice(-1).map(f=>f.geometry.coordinates),...S.forecast.map(f=>[f.longitude,f.latitude])].map(v=>`${g.x(v[0])},${g.y(v[1])}`).join(" "),context=S.locations.features.flatMap(l=>S.layers.filter(x=>S.active.has(x.layer_id)).map(x=>`<polygon points="${shape(l,g)}" fill="${colour[x.layer_id]}" fill-opacity=".1" stroke="${colour[x.layer_id]}"/>`)).join(""),heat=S.active.has("risk")?S.locations.features.map(l=>{const r=risk(l.properties.location_id);return r?`<polygon tabindex="0" role="button" data-id="${r.location_id}" points="${shape(l,g)}" fill="${band[r.band]}" fill-opacity=".42" stroke="${band[r.band]}" stroke-width="2"><title>${l.properties.name}: ${r.risk_score}/100 ${r.band}</title></polygon>`:""}).join(""):"";
  map.innerHTML=`<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" height="100%"><defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#19334e"/></pattern></defs><rect width="100%" height="100%" fill="#081727"/><rect width="100%" height="100%" fill="url(#grid)"/>${context}${heat}${S.active.has("track")?`<polyline points="${path}" fill="none" stroke="#ff6270" stroke-width="4"/>`:""}${S.active.has("forecast")?`<polyline points="${pred}" fill="none" stroke="#b591ff" stroke-width="3" stroke-dasharray="10 7"/>`:""}<text x="24" y="545" fill="#7897b8" font-size="13">Local coordinate-map fallback</text></svg>`;
  map.querySelectorAll("[data-id]").forEach(x=>{x.onclick=()=>showLocation(x.dataset.id);x.onkeydown=e=>e.key==="Enter"&&showLocation(x.dataset.id)});
}

function draw(){
  if(!S.track) return;
  if(googleMapsReady && window.google?.maps){
    drawGoogleMap();
  } else {
    drawFallback();
  }
}

function driver(items){const m=Math.max(...items.map(x=>x.score_points),1);return`<div class="drivers">${items.slice().sort((a,b)=>b.score_points-a.score_points).map(x=>`<div class="driver"><span>${x.name}</span><span class="bar"><i style="width:${Math.max(4,x.score_points/m*100)}%"></i></span><strong>${x.score_points} pts</strong></div>`).join("")}</div>`}

async function showLocation(id){try{const r=await get(`/locations/${encodeURIComponent(id)}/risk?cyclone_id=${encodeURIComponent(event().cyclone_id)}&valid_time=${encodeURIComponent(time.value)}`),n=locationData(id)?.name||id;$("#risk-source").textContent=label(r.source_type);$("#risk-source").className=`badge ${kind(r.source_type)}`;$("#risk-detail").className="";$("#risk-detail").innerHTML=`<div class="value ${r.band}">${r.risk_score}</div><span class="badge ${kind(r.source_type)}">${label(r.source_type)}</span><h3 style="margin:10px 0">${n}</h3><div class="row"><span>Risk level</span><strong class="${r.band}">${r.band.toUpperCase()}</strong></div><div class="row"><span>Valid time</span><strong>${r.valid_time}</strong></div><div class="row"><span>Model</span><strong>${r.model_version}</strong></div><h3 style="margin:16px 0 8px">Key drivers</h3>${driver(r.feature_contributions)}`;$("#risk-score-display").textContent=r.risk_score;$("#risk-score-display").className=`value ${r.band}`;$("#risk-band-display").textContent=r.band.toUpperCase();$("#risk-band-display").className=r.band;$("#risk-location-display").textContent=`${n} · ${label(r.source_type).toLowerCase()} data`;$("#driver-chart").className="";$("#driver-chart").innerHTML=driver(r.feature_contributions);document.querySelectorAll(".choice").forEach(b=>b.classList.toggle("selected",b.dataset.id===id))}catch(e){log("location risk",e);$("#risk-detail").textContent=`Unable to load location risk: ${e.message}`}}

function controls(){const h=$("#layer-controls");h.replaceChildren();[{layer_id:"track",name:"Cyclone track"},{layer_id:"forecast",name:"Forecast path"},{layer_id:"risk",name:"Risk heatmap"},...S.layers].forEach(l=>{const z=document.createElement("label"),i=document.createElement("input");z.className="control";i.type="checkbox";i.checked=S.active.has(l.layer_id);i.onchange=()=>{i.checked?S.active.add(l.layer_id):S.active.delete(l.layer_id);draw()};z.append(i,` ${l.name}`);h.append(z)})}

function riskList(){const h=$("#risk-location-list");h.replaceChildren();S.risk.features.forEach(f=>{const r=f.properties,b=document.createElement("button");b.className="choice";b.dataset.id=r.location_id;b.innerHTML=`<span>${locationData(r.location_id)?.name||r.location_id} <small class="muted">${label(r.source_type)}</small></span><strong class="${r.band}">${r.risk_score} ${r.band.toUpperCase()}</strong>`;b.onclick=()=>showLocation(r.location_id);h.append(b)});const s=S.risk.features[0]?.properties.source_type;$("#risk-page-source").textContent=label(s);$("#risk-page-source").className=`badge ${kind(s)}`}

async function loadRisk(){S.risk=await get(`/cyclones/${encodeURIComponent(event().cyclone_id)}/risk?valid_time=${encodeURIComponent(time.value)}`);$("#risk-detail").className="empty";$("#risk-detail").textContent=S.risk.features.length?"Select a colored grid to inspect its actual score, source, and contributing factors.":"No local risk or exposure coverage is available for this historical replay.";$("#risk-score-display").textContent="—";$("#risk-band-display").textContent=S.risk.features.length?"SELECT A LOCATION":"NO LOCAL RISK COVERAGE";draw();riskList();overview()}

function overview(){const top=S.risk.features.map(f=>f.properties).sort((a,b)=>b.risk_score-a.risk_score)[0],l=top&&locationData(top.location_id),last=points().at(-1).properties,e=event(),data=[['Cyclone',e.name,`${e.basin} · ${e.observed_at}`],['Peak risk',top?`${top.risk_score}/100`:"Unavailable",top?`${top.band.toUpperCase()} · ${l.name}`:"No local risk coverage",top?.band],['Population exposure',l?Number(l.population).toLocaleString():"Unavailable",l?"Highest-risk demo grid":"No local exposure coverage"],['Observed wind',`${last.wind_speed} km/h`,last.timestamp]];$("#overview-title").textContent=`${e.name} — historical replay`;$("#overview-metrics").innerHTML=data.map(x=>`<article class="card metric"><div class="label">${x[0]}</div><div class="value ${x[3]||""}">${x[1]}</div><div class="muted">${x[2]}</div></article>`).join("");$("#system-status").innerHTML=`<div><span>Data pipeline</span><b>REPLAY AVAILABLE</b></div><div><span>Risk engine</span><b>${top?"READY":"TRACK-ONLY"}</b></div><div><span>Grounded assistant</span><b>LOCAL AVAILABLE</b></div><div><span>Alert workflow</span><b>${top?"LOCAL AVAILABLE":"NO RISK COVERAGE"}</b></div><p class="foot">${e.source} · ${e.observed_at}</p>`}

async function forecast(){try{const m=await get(`/cyclones/${encodeURIComponent(event().cyclone_id)}/forecast/metrics`),h=$("#forecast-timeline");h.replaceChildren();const first=points().at(-1).properties;[{timestamp:first.timestamp,wind_speed:first.wind_speed,source_type:"observed"},...S.forecast].forEach((p,i)=>{const b=document.createElement("button");b.className=`node ${i===0?"current":""}`;b.innerHTML=`<i></i>${i===0?"NOW":`+${p.horizon_hours}H`}<br><b>${p.wind_speed||p.intensity} km/h</b>`;b.onclick=()=>{$("#forecast-detail").textContent=`${label(p.source_type)} · ${p.timestamp||p.valid_time}${p.uncertainty_km?` · ±${p.uncertainty_km} km uncertainty`:""}`;if(i){time.value=p.valid_time;loadRisk()}};h.append(b)});$("#forecast-metrics").className="";$("#forecast-metrics").innerHTML=`<div class="row"><span>Model</span><strong>${m.model_version}</strong></div><div class="row"><span>Validation track error</span><strong>${m.validation.mean_track_error_km} km</strong></div><div class="row"><span>Test track error</span><strong>${m.test.mean_track_error_km} km</strong></div><div class="row"><span>Test wind MAE</span><strong>${m.test.mean_wind_mae_kph} km/h</strong></div>`}catch(e){$("#forecast-metrics").textContent=`Unable to load metrics: ${e.message}`}}

function ranges(){const n=Number($("#track-shift").value);$("#track-shift-output").textContent=`${Math.abs(n)} km ${n<0?"west":"east"}`;$("#intensity-output").textContent=`${Number($("#intensity-multiplier").value).toFixed(1)}×`;$("#rainfall-output").textContent=`${Number($("#rainfall-multiplier").value).toFixed(1)}×`}

function renderScenarioGoogleMap(containerId, data, color, isDashed, bounds) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  container.innerHTML = "";
  const pts = data.track.features.filter(f => f.geometry.type === "Point").map(f => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
  const mapInstance = new google.maps.Map(container, {
    zoom: 6,
    center: pts.length ? pts[pts.length - 1] : { lat: 19.0, lng: 85.0 },
    styles: darkMapStyles,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  if (isDashed) {
    new google.maps.Polyline({
      path: pts,
      map: mapInstance,
      strokeColor: color,
      strokeOpacity: 0,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "12px" }],
      zIndex: 10,
    });
  } else {
    new google.maps.Polyline({
      path: pts,
      map: mapInstance,
      strokeColor: color,
      strokeWeight: 4,
      strokeOpacity: 0.95,
      zIndex: 10,
    });
  }

  pts.forEach(p => {
    new google.maps.Circle({
      center: p,
      map: mapInstance,
      radius: 8000,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 1.5,
      zIndex: 11,
    });
  });

  if (S.locations?.features) {
    const scores = Object.fromEntries((data.risk_scores || []).map(s => [s.location_id, s]));
    S.locations.features.forEach(l => {
      const s = scores[l.properties.location_id];
      const col = s ? (band[s.band] || color) : "#56d7a8";
      const paths = l.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
      new google.maps.Polygon({
        paths,
        map: mapInstance,
        fillColor: col,
        fillOpacity: 0.42,
        strokeColor: col,
        strokeWeight: 2,
        zIndex: 5,
      });
    });
  }

  if (bounds && !bounds.isEmpty()) {
    mapInstance.fitBounds(bounds, { top: 20, right: 20, bottom: 20, left: 20 });
  }
  return mapInstance;
}

function mini(data,c,dash){
  const p=data.track.features.filter(f=>f.geometry.type==="Point").map(f=>f.geometry.coordinates);
  const locPts = (S.locations?.features || []).flatMap(f=>f.geometry.coordinates[0]);
  const allPts = [...p, ...locPts];
  const lo=allPts.map(x=>x[0]),la=allPts.map(x=>x[1]);
  const minLo=Math.min(...lo),maxLo=Math.max(...lo);
  const minLa=Math.min(...la),maxLa=Math.max(...la);
  const x=v=>25+(v-minLo)/(maxLo-minLo||1)*750;
  const y=v=>260-(25+(v-minLa)/(maxLa-minLa||1)*210);
  const polyline=`<polyline points="${p.map(q=>`${x(q[0])},${y(q[1])}`).join(" ")}" fill="none" stroke="${c}" stroke-width="4" ${dash?'stroke-dasharray="10 7"':""}/>`;
  const scores = Object.fromEntries((data.risk_scores || []).map(s=>[s.location_id, s]));
  const polys = (S.locations?.features || []).map(l => {
    const s = scores[l.properties.location_id];
    const col = s ? (band[s.band] || c) : "#56d7a8";
    const pts = l.geometry.coordinates[0].map(v=>`${x(v[0])},${y(v[1])}`).join(" ");
    return `<polygon points="${pts}" fill="${col}" fill-opacity=".38" stroke="${col}" stroke-width="2"/>`;
  }).join("");
  return`<svg class="scenario-map" viewBox="0 0 800 290" width="100%"><rect width="100%" height="100%" fill="#081727"/>${polys}${polyline}</svg>`;
}

async function scenario(){
  const b=$("#run-simulation"),h=$("#scenario-summary");
  b.disabled=true;
  b.textContent="Running…";
  h.className="empty";
  h.textContent="Running deterministic simulation…";
  try{
    const r=await get("/scenario",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        cyclone_id:event().cyclone_id,
        valid_time:time.value,
        parameters:{
          track_shift_km:Number($("#track-shift").value),
          intensity_multiplier:Number($("#intensity-multiplier").value),
          rainfall_multiplier:Number($("#rainfall-multiplier").value)
        }
      })
    });
    h.className="";
    h.innerHTML=`<div class="comparison-wrap"><table class="comparison"><tr><th>Location</th><th>Baseline</th><th>Simulation</th><th>Δ</th></tr>${r.comparison.locations.map(x=>`<tr><td>${x.name}</td><td>${x.baseline_risk_score} ${x.baseline_band}</td><td>${x.simulation_risk_score} ${x.simulation_band}</td><td class="${x.risk_score_delta>0?"high":""}">${x.risk_score_delta>=0?"+":""}${x.risk_score_delta}</td></tr>`).join("")}</table></div><p class="foot">${r.explanation.answer}</p>`;
    $("#scenario-state").textContent="SIMULATION READY";
    $("#scenario-comparison").className="";
    $("#scenario-comparison").innerHTML=`
      <div class="split">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="badge observed">BASELINE</span>
            <span class="muted" style="font-size:11px">Observed Track & Baseline Risk</span>
          </div>
          <div id="scenario-map-baseline" class="scenario-map" style="height:320px;border-radius:4px;overflow:hidden"></div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span class="badge simulated">SIMULATION</span>
            <span class="muted" style="font-size:11px">Shifted Track & Simulated Risk</span>
          </div>
          <div id="scenario-map-simulation" class="scenario-map" style="height:320px;border-radius:4px;overflow:hidden"></div>
        </div>
      </div>`;

    if(googleMapsReady && window.google?.maps){
      const bounds = new google.maps.LatLngBounds();
      const addPts = t => t.features.filter(f => f.geometry.type === "Point").forEach(f => bounds.extend({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
      addPts(r.baseline.track);
      addPts(r.simulation.track);
      if (S.locations?.features) {
        S.locations.features.forEach(l => l.geometry.coordinates[0].forEach(([lng, lat]) => bounds.extend({ lat, lng })));
      }
      scenarioMaps = [
        renderScenarioGoogleMap("scenario-map-baseline", r.baseline, "#ff6270", false, bounds),
        renderScenarioGoogleMap("scenario-map-simulation", r.simulation, "#f5c451", true, bounds)
      ];
    } else {
      document.getElementById("scenario-map-baseline").innerHTML = mini(r.baseline, "#ff6270", false);
      document.getElementById("scenario-map-simulation").innerHTML = mini(r.simulation, "#f5c451", true);
    }
  }catch(e){
    h.className="empty";
    h.textContent=`Simulation unavailable: ${e.message}`;
  }finally{
    b.disabled=false;
    b.textContent="Run simulation";
  }
}

async function ask(e){e?.preventDefault();const q=$("#assistant-question").value.trim();if(!q)return;$("#assistant-response").textContent="Retrieving structured cyclone context…";try{const r=await get("/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:q,cyclone_id:event().cyclone_id,valid_time:time.value})});$("#assistant-response").textContent=`${r.answer}\n\n${(r.uncertainty||[]).join(" ")}`;$("#assistant-evidence").className="evidence";$("#assistant-evidence").innerHTML=r.evidence.map(x=>`<div><b>${x.kind}</b><br>${x.source}<br><span class="muted">${x.timestamp}</span></div>`).join("")}catch(e){$("#assistant-response").textContent=`Gemini analysis is temporarily unavailable. Map and risk data remain available.\n\n${e.message}`}}

async function status(){try{const s=await get("/alerts/status");$("#alert-state").textContent=`Threshold: ${s.threshold}/100. Pipeline ${s.stale?"STALE — run an evaluation":"current"}. Last event: ${s.last_event_id||"none"}.`;$("#alert-meta").textContent=`Configured threshold ${s.threshold}/100 · last event ${s.last_event_id||"none"}`;$("#alert-status-badge").textContent=s.stale?"STALE":"PIPELINE CURRENT"}catch(e){$("#alert-state").textContent=`Unable to load alert status: ${e.message}`}}

async function alert(){const b=$("#run-alert");b.disabled=true;b.textContent="Processing…";try{const r=await get("/alerts/trigger",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cyclone_id:event().cyclone_id,valid_time:time.value})});$("#alert-list").innerHTML=r.result.outcomes.map(x=>x.alert?`<article class="alert high"><b>${x.alert.alert_type.replaceAll("_"," ").toUpperCase()}</b><br>${x.alert.message}<p class="foot">${x.alert.location_id} · ${x.status}</p></article>`:`<article class="alert"><b>${x.location_id}</b><br>${x.status.replaceAll("_"," ")}</article>`).join("");await status()}catch(e){$("#alert-state").textContent=`Unable to process alert: ${e.message}`}finally{b.disabled=false;b.textContent="Run local risk evaluation"}}

async function load(){
  gMap = null;
  const e=event();
  $("#metadata").textContent="Loading historical replay…";
  try{
    const [t,l,f,ly]=await Promise.all([
      get(`/cyclones/${encodeURIComponent(e.cyclone_id)}/track`),
      get(`/cyclones/${encodeURIComponent(e.cyclone_id)}/locations`),
      get(`/cyclones/${encodeURIComponent(e.cyclone_id)}/forecast`).then(x=>x.points),
      get(`/cyclones/${encodeURIComponent(e.cyclone_id)}/layers`)
    ]);
    Object.assign(S,{track:t,locations:l,forecast:f,layers:ly,active:new Set(["track","forecast","risk",...ly.map(x=>x.layer_id)])});
    time.replaceChildren();
    const last=points().at(-1).properties.timestamp;
    time.add(new Option(`Observed · ${last}`,last));
    f.forEach(p=>time.add(new Option(`Forecast +${p.horizon_hours}h · ${p.valid_time} · ±${p.uncertainty_km} km`,p.valid_time)));
    controls();
    $("#metadata").textContent=`Source: ${e.source} · observed ${e.observed_at} · historical replay data`;
    await Promise.all([loadRisk(),status(),forecast()]);
  }catch(error){
    map.textContent=`Unable to load cyclone data: ${error.message}`;
    $("#metadata").textContent=`Unable to load ${e.name}. Use Refresh data to retry.`;
  }
}

async function start(){
  await initGoogleMaps();
  const c=await get("/cyclones");
  c.forEach(e=>{const o=new Option(e.name,e.cyclone_id);o.dataset.event=JSON.stringify(e);cyclone.add(o)});
  cyclone.onchange=load;
  time.onchange=()=>{loadRisk();forecast()};
  $("#refresh-data").onclick=load;
  $("#assistant-form").onsubmit=ask;
  $("#run-simulation").onclick=scenario;
  $("#run-alert").onclick=alert;
  ["#track-shift","#intensity-multiplier","#rainfall-multiplier"].forEach(x=>$(x).oninput=ranges);
  $("#start-demo").onclick=()=>{
    $("#track-shift").value=20;
    $("#intensity-multiplier").value=1.2;
    $("#rainfall-multiplier").value=1.1;
    ranges();
    document.querySelector('[data-page="map"]').click();
  };
  ["Why is this region high risk?","What are the main risk drivers?","What areas are most exposed?","Summarize the current cyclone situation.","What is observed versus predicted?"].forEach(q=>{
    const b=document.createElement("button");
    b.className="suggestion";
    b.textContent=q;
    b.onclick=()=>{
      $("#assistant-question").value=q;
      ask();
    };
    $("#suggestions").append(b);
  });
  ranges();
  await load();
}

let rt;
window.addEventListener("resize",()=>{
  clearTimeout(rt);
  rt=setTimeout(()=>{
    if(document.querySelector("#page-map")?.classList.contains("active")){
      if(gMap && window.google?.maps) google.maps.event.trigger(gMap, "resize");
      draw();
    }
  },150);
});

start().catch(e=>map.textContent=`Unable to start command center: ${e.message}`);
