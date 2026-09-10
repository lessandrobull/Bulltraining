export default async function handler(req, res) {
  const API_KEY = '3pcp8m39g3wupqh688l1zcvtf';
  const ATHLETE_ID = 'i704231';
  const SUPABASE_URL = 'https://xttzilpuuqjbztjkeadd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_uexabKupvCYRAAPqRiETSQ_I01UsSZI';

  const authHeader = 'Basic ' + Buffer.from('API_KEY:' + API_KEY).toString('base64');

  try {
    const isFull = req.query.full === 'true';
    let oldest = req.query.oldest;

    if (!oldest) {
      if (isFull) {
        oldest = '2024-01-01';
      } else {
        const d = new Date();
        d.setDate(d.getDate() - 15);
        oldest = d.toISOString().split('T')[0];
      }
    }

    const listRes = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/activities?oldest=${oldest}`, {
      headers: { Authorization: authHeader }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      return res.status(listRes.status).json({ error: 'Erro no Intervals.icu', details: errText });
    }

    const activities = await listRes.json();
    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(200).json({ message: 'Nenhum treino encontrado.', synced: 0 });
    }

    const supaCheck = await fetch(`${SUPABASE_URL}/rest/v1/workouts?select=id,start_time,laps,trackpoints`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const existing = await supaCheck.json();
    const existingMap = new Map();
    (existing || []).forEach(w => {
      existingMap.set(w.start_time, w);
    });

    let hrRest = 50;
    let hrMax = 185;
    try {
      const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?id=eq.1&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const settingsData = await settingsRes.json();
      if (settingsData && settingsData[0]) {
        hrRest = settingsData[0].hr_rest || 50;
        hrMax = settingsData[0].hr_max || 185;
      }
    } catch (e) {
      console.warn('Usando FC padrão:', e);
    }

    let syncedCount = 0;
    let updatedCount = 0;

    for (const act of activities) {
      const startTime = act.start_date_local || act.start_date;
      const existingWorkout = existingMap.get(startTime);

      // Se não for sincronização total, pula treinos que já possuem o pace oficial nas voltas
      const hasLapsWithPace = existingWorkout && 
        Array.isArray(existingWorkout.laps) && 
        existingWorkout.laps.length > 0 && 
        existingWorkout.laps[0].pace !== undefined;

      if (!isFull && hasLapsWithPace) {
        continue;
      }

      // 1. Obter telemetria (streams) com velocity_smooth
      let trackpoints = [];
      let timeStream = [];
      let distStream = [];
      let hrStream = [];
      let altStream = [];
      let velStream = [];

      try {
        let streamRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}/streams.json`, {
          headers: { Authorization: authHeader }
        });

        if (!streamRes.ok) {
          streamRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}/streams?types=time,distance,heartrate,altitude,velocity_smooth`, {
            headers: { Authorization: authHeader }
          });
        }

        if (streamRes.ok) {
          const streams = await streamRes.json();
          timeStream = streams.find(s => s.type === 'time')?.data || [];
          distStream = streams.find(s => s.type === 'distance')?.data || [];
          hrStream = streams.find(s => s.type === 'heartrate')?.data || [];
          altStream = streams.find(s => s.type === 'altitude')?.data || [];
          velStream = streams.find(s => s.type === 'velocity_smooth')?.data || [];

          for (let j = 0; j < distStream.length; j += 3) {
            let pSecs = null;
            const v = (velStream && velStream.length > j) ? velStream[j] : null;

            // Usa velocidade instantânea oficial do sensor (m/s) para converter em s/km
            if (v !== null && v > 0.5) {
              const paceVal = Math.round(1000 / v);
              if (paceVal >= 90 && paceVal <= 900) {
                pSecs = paceVal;
              }
            } else if (j >= 3 && timeStream.length > j) {
              const dDist = distStream[j] - distStream[j - 3];
              const dTime = timeStream[j] - timeStream[j - 3];
              if (dDist > 3 && dTime > 0) {
                const spk = dTime / (dDist / 1000);
                if (spk >= 120 && spk <= 800) {
                  pSecs = Math.round(spk);
                }
              }
            }

            trackpoints.push({
              dist: distStream[j] || 0,
              hr: hrStream[j] || 0,
              alt: altStream[j] || 0,
              pace: pSecs,
              time: timeStream[j] || 0
            });
          }
        }
      } catch (e) {
        console.warn(`Streams indisponíveis para atividade ${act.id}:`, e);
      }

      // 2. Obter voltas oficiais da Garmin (FIT laps)
      let laps = [];
      try {
        const actDetailRes = await fetch(`https://intervals.icu/api/v1/activity/${act.id}?intervals=true`, {
          headers: { Authorization: authHeader }
        });
        if (actDetailRes.ok) {
          const actDetail = await actDetailRes.json();
          
          // Prioridade 1: laps nativos gravados pelo relógio Garmin
          const rawLaps = (Array.isArray(actDetail.laps) && actDetail.laps.length > 0)
            ? actDetail.laps
            : (Array.isArray(actDetail.icu_intervals) && actDetail.icu_intervals.length > 0)
              ? actDetail.icu_intervals
              : [];

          if (rawLaps.length > 0) {
            laps = rawLaps.map((lap, idx) => {
              let meters = lap.distance;
              if ((meters === undefined || meters === null) && lap.start_index !== undefined && lap.end_index !== undefined && distStream.length > 0) {
                const eIdx = Math.min(distStream.length - 1, lap.end_index);
                const sIdx = Math.min(distStream.length - 1, Math.max(0, lap.start_index));
                meters = distStream[eIdx] - distStream[sIdx];
              }
              meters = Math.round(meters || 0);

              let seconds = lap.moving_time || lap.elapsed_time;
              if ((seconds === undefined || seconds === null) && lap.start_index !== undefined && lap.end_index !== undefined && timeStream.length > 0) {
                const eIdx = Math.min(timeStream.length - 1, lap.end_index);
                const sIdx = Math.min(timeStream.length - 1, Math.max(0, lap.start_index));
                seconds = timeStream[eIdx] - timeStream[sIdx];
              }
              seconds = Math.round(seconds || 0);

              // Velocidade média da volta registrada pelo Garmin (m/s)
              let avgSpeed = lap.average_speed || lap.avg_speed || 0;
              if (!avgSpeed && seconds > 0 && meters > 0) {
                avgSpeed = meters / seconds;
              }

              // Pace oficial da volta em segundos/km (1000 / avgSpeed)
              const lapPace = avgSpeed > 0 
                ? Math.round(1000 / avgSpeed) 
                : (meters > 0 && seconds > 0 ? Math.round(seconds / (meters / 1000)) : 0);

              let avgHr = lap.average_heartrate || lap.avg_heart_rate || 0;
              let maxHr = lap.max_heartrate || lap.max_heart_rate || 0;

              if ((!avgHr || !maxHr) && lap.start_index !== undefined && lap.end_index !== undefined && hrStream.length > 0) {
                let hrSum = 0;
                let hrCount = 0;
                let hrMaxVal = 0;
                const sIdx = Math.max(0, lap.start_index);
                const eIdx = Math.min(hrStream.length, lap.end_index);
                for (let k = sIdx; k < eIdx; k++) {
                  const h = hrStream[k];
                  if (h && h > 0) {
                    hrSum += h;
                    hrCount++;
                    if (h > hrMaxVal) hrMaxVal = h;
                  }
                }
                if (!avgHr && hrCount > 0) avgHr = Math.round(hrSum / hrCount);
                if (!maxHr && hrMaxVal > 0) maxHr = hrMaxVal;
              }

              return {
                lap: idx + 1,
                seconds: seconds,
                meters: meters,
                avg_speed: avgSpeed,
                pace: lapPace,
                avgHr: Math.round(avgHr || 0),
                maxHr: Math.round(maxHr || 0)
              };
            });
          }
        }
      } catch (e) {
        console.warn('Erro ao consultar voltas nativas:', e);
      }

      // 3. Fallback: Se não houver marcação de voltas, fatiar em splits de 1 km
      if (laps.length <= 1 && distStream.length > 0) {
        const splits = [];
        let lapStartIndex = 0;
        let nextTargetDist = 1000;
        let lapNum = 1;

        for (let i = 0; i < distStream.length; i++) {
          const d = distStream[i];
          const isLast = (i === distStream.length - 1);

          if (d >= nextTargetDist || isLast) {
            const lapMeters = d - (lapStartIndex > 0 ? distStream[lapStartIndex] : 0);
            const tEnd = (timeStream.length > i) ? timeStream[i] : i;
            const tStart = (timeStream.length > lapStartIndex && lapStartIndex > 0) ? timeStream[lapStartIndex] : lapStartIndex;
            const lapSecs = tEnd - tStart;

            if (lapMeters >= 40 && lapSecs > 0) {
              let hrSum = 0;
              let hrCount = 0;
              let lapMaxHr = 0;
              let velSum = 0;
              let velCount = 0;

              for (let j = lapStartIndex; j <= i; j++) {
                const h = hrStream[j];
                if (h && h > 0) {
                  hrSum += h;
                  hrCount++;
                  if (h > lapMaxHr) lapMaxHr = h;
                }
                if (velStream.length > j && velStream[j] && velStream[j] > 0.5) {
                  velSum += velStream[j];
                  velCount++;
                }
              }

              const avgSpeed = velCount > 0 ? (velSum / velCount) : (lapMeters / lapSecs);
              const lapPace = avgSpeed > 0 ? Math.round(1000 / avgSpeed) : Math.round(lapSecs / (lapMeters / 1000));

              splits.push({
                lap: lapNum++,
                seconds: Math.round(lapSecs),
                meters: Math.round(lapMeters),
                avg_speed: avgSpeed,
                pace: lapPace,
                avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : 0,
                maxHr: lapMaxHr
              });
            }

            lapStartIndex = i;
            nextTargetDist += 1000;
          }
        }

        if (splits.length > 0) laps = splits;
      }

      // 4. Duração alinhada à velocidade média oficial do Garmin
      const durationSecs = (act.average_speed && act.average_speed > 0 && act.distance > 0)
        ? Math.round(act.distance / act.average_speed)
        : (act.moving_time || act.elapsed_time || 0);

      const avgHr = Math.round(act.average_heartrate || 0);
      const durationMin = durationSecs / 60;
      const hrRatio = avgHr > hrRest ? (avgHr - hrRest) / (hrMax - hrRest) : 0;
      const trimp = durationMin * hrRatio * 0.64 * Math.exp(1.92 * hrRatio);

      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/workouts?on_conflict=start_time`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          start_time: startTime,
          sport: (act.type || 'running').toLowerCase(),
          distance_meters: act.distance || 0,
          duration_seconds: durationSecs,
          avg_heart_rate: avgHr,
          max_heart_rate: Math.round(act.max_heartrate || 0),
          trimp_score: trimp,
          laps: laps,
          trackpoints: trackpoints,
          is_deleted: false
        })
      });

      if (saveRes.ok) {
        if (existingWorkout) updatedCount++;
        else syncedCount++;
      }
    }

    return res.status(200).json({ 
      success: true, 
      novosSincronizados: syncedCount, 
      atualizadosComPaceOficial: updatedCount, 
      totalAnalisados: activities.length 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
