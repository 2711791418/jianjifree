export async function onRequest({ env }) {
  return Response.json({
    status: 'ok',
    time: new Date().toISOString(),
    engines: {
      deepseek: !!env.DEEPSEEK_API_KEY,
      qianwen:  !!env.QIANWEN_API_KEY,
      doubao:   !!env.DOUBAO_API_KEY,
      yuanbao:  !!env.YUANBAO_API_KEY,
    },
  });
}
