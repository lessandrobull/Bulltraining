export default async function handler(req, res) {
  const API_KEY = '3pcp8m39g3wupqh688l1zcvtf';
  const ATHLETE_ID = 'i704231';
  const WEBHOOK_URL = 'https://bulltraining.vercel.app/api/webhook';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
    const response = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/events`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: WEBHOOK_URL
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ erro: 'Falha ao registrar', detalhes: data });
    }

    return res.status(200).json({
      sucesso: true,
      mensagem: 'Webhook registrado com sucesso no Intervals.icu!',
      respostaIntervals: data
    });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
