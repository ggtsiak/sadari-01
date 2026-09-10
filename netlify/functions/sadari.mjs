import { getStore } from "@netlify/blobs";

const STORE = "sadari-rooms";

const json = (body, status=200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

function ladder(N) {
  const rows = 14;
  const L = Array.from({length: rows}, () => []);
  for (let r=0;r<rows;r++) {
    const order = Array.from({length:N-1},(_,i)=>i).sort(()=>Math.random()-.5);
    order.forEach(c=>{
      if (Math.random()<.34 && !L[r].some(x=>Math.abs(x-c)<=1)) L[r].push(c);
    });
  }
  if (L.every(a=>a.length===0)) L[Math.floor(rows/2)]=[0,2,4,6].filter(c=>c<N-1);
  return L;
}

function calc(L,N) {
  return Array.from({length:N},(_,start)=>{
    let c=start;
    L.forEach(row=>{
      if(row.includes(c)) c++;
      else if(row.includes(c-1)) c--;
    });
    return c+1;
  });
}

function cleanState(s) {
  return {
    N:s.N, players:s.players||{}, started:!!s.started,
    lines:s.lines||[], outcomes:s.outcomes||[], revealed:s.revealed||[],
    revision:s.revision||0
  };
}

async function readRoom(store, room) {
  const entry = await store.getWithMetadata(room, { type:"json" });
  if (!entry) return null;
  return entry;
}

async function updateRoom(store, room, mutate) {
  for(let attempt=0; attempt<8; attempt++){
    const entry = await readRoom(store, room);
    if(!entry) return {error:"방을 찾을 수 없습니다.", status:404};
    const state = structuredClone(entry.data);
    const result = await mutate(state);
    if(result?.error) return result;
    state.revision=(state.revision||0)+1;
    const saved=await store.setJSON(room,state,{onlyIfMatch:entry.etag});
    if(saved.modified) {
      const extra=(result && typeof result==="object") ? result : {};
      return {state,...extra};
    }
  }
  return {error:"동시에 처리된 요청이 많습니다. 잠시 후 다시 시도해 주세요.",status:409};
}

export default async (req) => {
  const store = getStore(STORE, { consistency:"strong" });

  if(req.method==="GET"){
    const url=new URL(req.url);
    const room=(url.searchParams.get("room")||"").trim();
    const role=url.searchParams.get("role");
    const token=url.searchParams.get("token");
    const id=url.searchParams.get("id");
    if(!/^\d{2}$/.test(room)) return json({error:"잘못된 방 코드입니다."},400);
    const entry=await readRoom(store,room);
    if(!entry) return json({error:"방을 찾을 수 없습니다."},404);
    const s=entry.data;
    const ok=role==="host" ? token===s.hostToken : role==="player" && !!s.players?.[id];
    if(!ok) return json({error:"접속 권한이 없습니다."},403);
    return json({state:cleanState(s)});
  }

  if(req.method!=="POST") return json({error:"Method not allowed"},405);
  let body;
  try{body=await req.json()}catch(e){return json({error:"잘못된 요청입니다."},400)}
  const op=body.op, room=String(body.room||"").trim();

  if(op==="create"){
    if(!/^\d{2}$/.test(room)||!Number.isInteger(body.N)||body.N<2||body.N>16||!body.token)
      return json({error:"방 생성 정보가 올바르지 않습니다."},400);
    const state={
      N:body.N, hostToken:body.token, players:{}, started:false,
      lines:[], outcomes:[], revealed:[], revision:1, createdAt:Date.now()
    };
    const saved=await store.setJSON(room,state,{onlyIfNew:true});
    if(!saved.modified) return json({error:"이미 사용 중인 방 코드입니다."},409);
    return json({state:cleanState(state)});
  }

  if(op==="join"){
    const name=String(body.name||"").trim();
    if(!/^\d{2}$/.test(room)||!name||name.length>12)
      return json({error:"참가 정보가 올바르지 않습니다."},400);

    // 같은 방 + 같은 이름이면 새 참가자로 만들지 않고 기존 참가자로 재입장
    const entry=await readRoom(store,room);
    if(!entry) return json({error:"방을 찾을 수 없습니다."},404);

    const existing=Object.entries(entry.data.players||{})
      .find(([,p])=>p.name===name);

    if(existing){
      return json({
        playerId:existing[0],
        state:cleanState(entry.data),
        rejoined:true
      });
    }

    const playerId=crypto.randomUUID();
    const result=await updateRoom(store,room,async s=>{
      // 동시에 같은 이름이 들어오는 경우를 다시 확인
      const same=Object.entries(s.players||{})
        .find(([,p])=>p.name===name);

      if(same){
        return {
          playerId:same[0],
          state:cleanState(s),
          rejoined:true
        };
      }

      if(Object.keys(s.players||{}).length>=s.N-1)
        return {error:"참가자가 모두 찼습니다.",status:409};

      s.players[playerId]={name,num:null,revealed:false};
      return {playerId,state:cleanState(s)};
    });

    if(result.error) return json({error:result.error},result.status||400);

    // updateRoom은 상태를 저장하므로 정상 신규 입장에서는 저장된 state를 반환
    return json({
      playerId:result.playerId || playerId,
      state:result.state,
      rejoined:!!result.rejoined
    });
  }
  if(op==="start"){
    const result=await updateRoom(store,room,async s=>{
      if(body.token!==s.hostToken)return {error:"방장 권한이 없습니다.",status:403};
      if(s.started)return null;
      s.lines=ladder(s.N); s.outcomes=calc(s.lines,s.N);
      s.started=true; s.revealed=[];
      return null;
    });
    if(result.error)return json({error:result.error},result.status||400);
    return json({state:cleanState(result.state)});
  }

  if(op==="pick"){
    const id=String(body.id||""), num=Number(body.num);
    if(!Number.isInteger(num))return json({error:"번호가 올바르지 않습니다."},400);
    const result=await updateRoom(store,room,async s=>{
      const p=s.players?.[id];
      if(!p)return {error:"참가 정보를 찾을 수 없습니다.",status:403};
      if(!s.started)return {error:"아직 사다리가 시작되지 않았습니다.",status:409};
      if(p.num)return {error:"이미 번호를 선택했습니다.",status:409};
      if(num<1||num>s.N)return {error:"잘못된 번호입니다.",status:400};
      if(Object.values(s.players).some(x=>x.num===num))return {error:"이미 다른 참가자가 먼저 선택한 번호입니다.",status:409};
      p.num=num; p.revealed=true;
      s.revealed.push({name:p.name,num,result:s.outcomes[num-1],peer:id});
      const all=Object.values(s.players).every(x=>x.num);
      if(all && !s.revealed.some(x=>x.name==="방장")){
        const used=new Set(Object.values(s.players).map(x=>x.num));
        const remain=Array.from({length:s.N},(_,i)=>i+1).find(n=>!used.has(n));
        if(remain){
          s.revealed.push({name:"방장",num:remain,result:s.outcomes[remain-1],peer:"host"});
        }
      }
      return null;
    });
    if(result.error)return json({error:result.error},result.status||400);
    return json({accepted:true,state:cleanState(result.state)});
  }

  if(op==="reset"){
    const result=await updateRoom(store,room,async s=>{
      if(body.token!==s.hostToken)return {error:"방장 권한이 없습니다.",status:403};
      s.started=false;s.lines=[];s.outcomes=[];s.revealed=[];
      Object.values(s.players).forEach(p=>{p.num=null;p.revealed=false});
      return null;
    });
    if(result.error)return json({error:result.error},result.status||400);
    return json({state:cleanState(result.state)});
  }

  return json({error:"알 수 없는 요청입니다."},400);
};
