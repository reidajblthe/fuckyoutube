// Verificação opcional de integração: depende da rede e da disponibilidade do YouTube.
const origin = process.env.TEST_ORIGIN || 'http://localhost:3000';
let song;
for (const type of ['songs', 'artists', 'albums']) {
  const response = await fetch(`${origin}/api/search?q=jazz&type=${type}`, { signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  console.log(type, response.status, 'itens:', data.items?.length ?? 0, data.error || '');
  if (type === 'songs') song = data.items?.find((t) => t.duration > 0 && t.duration < 600) || data.items?.[0];
}
if (!song) { console.log('Sem faixa disponível para testar stream.'); process.exit(1); }
// Verifica só o primeiro intervalo; não grava áudio em disco.
const response = await fetch(`${origin}/api/stream/${song.id}`, {
  headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(45000)
});
console.log('stream', response.status, response.headers.get('content-type'), response.headers.get('content-range'));
if (!response.ok) console.log(await response.text());
else { console.log('bytes:', (await response.arrayBuffer()).byteLength); }
if (process.argv.includes('--full')) {
  try {
    let offset=0,total=Infinity;
    const signal=AbortSignal.timeout(90000);
    while(offset<total) {
      const full=await fetch(`${origin}/api/stream/${song.id}`,{headers:{Range:`bytes=${offset}-`},signal});
      if(full.status!==206) throw new Error(`HTTP ${full.status} no byte ${offset}`);
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(full.headers.get('content-range'));
      if(!range||Number(range[1])!==offset) throw new Error('Content-Range inválido.');
      const bytes=(await full.arrayBuffer()).byteLength;
      if(bytes!==Number(range[2])-offset+1) throw new Error('Corpo incompleto.');
      offset=Number(range[2])+1;total=Number(range[3]);
    }
    console.log('stream integral validado; bytes totais:',offset);
  } catch (error) {
    console.error('Stream integral não validado:', error.message);
    process.exitCode = 1;
  }
}
