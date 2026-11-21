'use client';

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Droplets, Activity, Settings, Play, Square, Settings2, ShieldCheck, ShieldAlert, CheckCircle2, Loader2 } from 'lucide-react';

// ==========================================
// UTILITIES (Konversi % dan Menit)
// ==========================================
const pwmToPercent = (pwm: number) => Math.round((pwm / 255) * 100);
const percentToPwm = (percent: number) => Math.round((percent / 100) * 255);
const secToMin = (sec: number) => Math.round(sec / 60);
const minToSec = (min: number) => min * 60;

const formatTime = (totalSec: number) => {
  if (totalSec <= 0) return "00:00";
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

export default function Dashboard() {
  const [sensorLogs, setSensorLogs] = useState<any[]>([]);
  const [deviceConfig, setDeviceConfig] = useState<any>(null);
  const [isClient, setIsClient] = useState(false);
  
  // UI States (Menggunakan % dan Menit)
  const [inputConfig, setInputConfig] = useState({
    coag_pwm_pct: 90, coag_duration_min: 5,
    floc_pwm_pct: 35, floc_duration_min: 20,
    sediment_duration_min: 30,
    pump_pwm_pct: 0
  });

  // State Timer Lokal
  const [liveRemainingSec, setLiveRemainingSec] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // ==========================================
  // INISIALISASI & BERLANGGANAN REAL-TIME
  // ==========================================
  useEffect(() => {
    setIsClient(true);
    fetchInitialData();

    const sensorSubscription = supabase
      .channel('sensor-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_logs' }, (payload) => {
        setSensorLogs((prev) => [...prev, payload.new].slice(-20));
      })
      .subscribe();

    const deviceSubscription = supabase
      .channel('device-changes')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'device_control' }, (payload) => {
        const config = payload.new;
        setDeviceConfig(config);
        
        if (config.batch_command !== 'START') {
           setInputConfig({
            coag_pwm_pct: pwmToPercent(config.coag_pwm), coag_duration_min: secToMin(config.coag_duration_sec),
            floc_pwm_pct: pwmToPercent(config.floc_pwm), floc_duration_min: secToMin(config.floc_duration_sec),
            sediment_duration_min: secToMin(config.sediment_duration_sec),
            pump_pwm_pct: pwmToPercent(config.pump_pwm)
          });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(sensorSubscription);
      supabase.removeChannel(deviceSubscription);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const fetchInitialData = async () => {
    const { data: logs } = await supabase.from('sensor_logs').select('*').order('created_at', { ascending: false }).limit(20);
    if (logs) setSensorLogs(logs.reverse());

    const { data: config } = await supabase.from('device_control').select('*').eq('id', 1).single();
    if (config) {
      setDeviceConfig(config);
      setInputConfig({
        coag_pwm_pct: pwmToPercent(config.coag_pwm), coag_duration_min: secToMin(config.coag_duration_sec),
        floc_pwm_pct: pwmToPercent(config.floc_pwm), floc_duration_min: secToMin(config.floc_duration_sec),
        sediment_duration_min: secToMin(config.sediment_duration_sec),
        pump_pwm_pct: pwmToPercent(config.pump_pwm)
      });
    }
  };

  // ==========================================
  // LOGIKA TIMER HITUNG MUNDUR (LIVE)
  // ==========================================
  const latestData = sensorLogs[sensorLogs.length - 1] || {};
  const currentPhase = latestData.batch_phase || 'IDLE';
  const isProcessActive = deviceConfig?.batch_command === 'START' && currentPhase !== 'COMPLETED' && currentPhase !== 'IDLE';

  useEffect(() => {
    if (isProcessActive) {
      let initialSec = 0;
      if (currentPhase === 'COAGULATION') initialSec = inputConfig.coag_duration_min * 60;
      else if (currentPhase === 'FLOCCULATION') initialSec = inputConfig.floc_duration_min * 60;
      else if (currentPhase === 'SEDIMENTATION') initialSec = inputConfig.sediment_duration_min * 60;
      
      setLiveRemainingSec(initialSec);

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setLiveRemainingSec((prev) => (prev > 0 ? prev - 1 : 0));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setLiveRemainingSec(0);
    }
  }, [currentPhase, isProcessActive]);


  // ==========================================
  // HANDLERS (Fungsi Kendali)
  // ==========================================
  const sendBatchCommand = async (command: string) => {
    setDeviceConfig((prev: any) => ({ ...prev, batch_command: command }));

    if (command === 'START') {
      setSensorLogs((prev) => [...prev, { ...(prev[prev.length -1] || {}), batch_phase: 'STARTING' }]);
      
      await supabase.from('device_control').update({
        batch_command: 'START',
        coag_pwm: percentToPwm(inputConfig.coag_pwm_pct),
        coag_duration_sec: minToSec(inputConfig.coag_duration_min),
        floc_pwm: percentToPwm(inputConfig.floc_pwm_pct),
        floc_duration_sec: minToSec(inputConfig.floc_duration_min),
        sediment_duration_sec: minToSec(inputConfig.sediment_duration_min),
        updated_at: new Date().toISOString()
      }).eq('id', 1);
    } else {
      await supabase.from('device_control').update({ 
        batch_command: 'STOP',
        updated_at: new Date().toISOString()
      }).eq('id', 1);
    }
  };

  const setPumpPWM = async (pct: number) => {
    setInputConfig(prev => ({ ...prev, pump_pwm_pct: pct }));
    await supabase.from('device_control').update({ 
      pump_pwm: percentToPwm(pct), 
      updated_at: new Date().toISOString() 
    }).eq('id', 1);
  };

  const handleNumberInput = (field: string, val: string) => {
    const num = parseInt(val);
    setInputConfig(prev => ({ ...prev, [field]: isNaN(num) ? '' : num }));
  };

  // ==========================================
  // RENDER HELPERS
  // ==========================================
  const getPhaseIndex = () => {
    switch (currentPhase) {
      case 'COAGULATION': return 1;
      case 'FLOCCULATION': return 2;
      case 'SEDIMENTATION': return 3;
      case 'COMPLETED': return 4;
      default: return 0;
    }
  };
  const phaseIdx = getPhaseIndex();

  if (!isClient) return null; // Cegah hydration errors di Next.js

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8 font-sans text-slate-100">
      
      {/* HEADER */}
      <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-2">
            <Droplets className="text-blue-400" size={32}/> ECOPURE-BATIK
          </h1>
          <p className="text-slate-400 mt-1 tracking-wide uppercase text-sm font-semibold">IoT Multistage Filtration System</p>
        </div>
        <div className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 w-fit border ${latestData.is_ph_safe ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'}`}>
          {latestData.is_ph_safe ? <ShieldCheck size={20}/> : <ShieldAlert size={20}/>}
          {latestData.is_ph_safe ? 'Effluent pH Safe (Standard)' : 'Warning: pH Out of Range!'}
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* LEFT COLUMN: VISUALS & CHARTS */}
        <div className="xl:col-span-2 space-y-6">
          
          {/* STEPPER PROGRESS (Alur Proses) */}
          <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
             <div className="flex items-center justify-between">
               {[
                 { step: 1, name: 'Coagulation' },
                 { step: 2, name: 'Flocculation' },
                 { step: 3, name: 'Sedimentation' },
                 { step: 4, name: 'Filtration' },
               ].map((item, idx) => (
                 <React.Fragment key={item.step}>
                   <div className="flex flex-col items-center gap-2 z-10 w-24">
                     <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg border-2 transition-all duration-500 ${phaseIdx === item.step ? 'bg-blue-500 border-blue-400 text-white shadow-[0_0_15px_rgba(59,130,246,0.5)]' : phaseIdx > item.step ? 'bg-emerald-500 border-emerald-400 text-white' : 'bg-slate-800 border-slate-600 text-slate-500'}`}>
                       {phaseIdx > item.step ? <CheckCircle2 size={20}/> : (phaseIdx === item.step && isProcessActive) ? <Loader2 size={20} className="animate-spin"/> : item.step}
                     </div>
                     <span className={`text-xs font-bold uppercase text-center ${phaseIdx === item.step ? 'text-blue-400' : phaseIdx > item.step ? 'text-emerald-400' : 'text-slate-500'}`}>{item.name}</span>
                   </div>
                   {idx < 3 && (
                     <div className={`flex-1 h-1 rounded-full transition-all duration-700 ${phaseIdx > item.step ? 'bg-emerald-500/50' : 'bg-slate-700'}`} />
                   )}
                 </React.Fragment>
               ))}
             </div>
          </div>

          {/* INDICATOR CARDS */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className={`p-5 rounded-2xl border transition-colors ${isProcessActive ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-800 border-slate-700'}`}>
              <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-2">pH IN (Chamber 1)</p>
              <p className="text-4xl font-bold text-slate-200">{latestData.ph_in?.toFixed(2) || '--'}</p>
            </div>
            <div className={`p-5 rounded-2xl border-2 transition-colors ${isProcessActive ? 'bg-blue-900/20 border-blue-500/50' : 'bg-slate-800 border-slate-700'}`}>
              <p className="text-xs text-blue-400 font-bold uppercase tracking-wider mb-2">pH OUT (Chamber 4)</p>
              <p className="text-4xl font-bold text-blue-400">{latestData.ph_out?.toFixed(2) || '--'}</p>
            </div>
            <div className="p-5 rounded-2xl border border-slate-700 bg-slate-800 flex flex-col justify-between">
              <p className="text-xs text-slate-400 font-bold uppercase tracking-wider">Active Phase</p>
              <div>
                <p className={`text-xl font-bold mt-2 ${isProcessActive ? 'text-amber-400' : currentPhase === 'COMPLETED' ? 'text-emerald-400' : 'text-slate-500'}`}>{currentPhase}</p>
                {isProcessActive && (
                  <p className="text-3xl font-mono font-light text-amber-300 mt-1">{formatTime(liveRemainingSec)}</p>
                )}
              </div>
            </div>
            <div className="p-5 rounded-2xl border border-slate-700 bg-slate-800 flex flex-col justify-between">
              <p className="text-xs text-slate-400 font-bold uppercase tracking-wider">Actuator Load</p>
              <div className="mt-2">
                <div className="flex justify-between text-sm mb-1"><span className="text-slate-400">Mixer</span><span className="font-bold text-slate-200">{pwmToPercent(latestData.mixer_pwm || 0)}%</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-400">Pump</span><span className="font-bold text-blue-400">{pwmToPercent(latestData.pump_pwm || 0)}%</span></div>
              </div>
            </div>
          </div>

          {/* REAL-TIME CHART */}
          <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow-xl">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-slate-200"><Activity size={20} className="text-blue-500"/> Real-time pH Monitoring</h2>
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sensorLogs} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155"/>
                  <XAxis dataKey="created_at" tickFormatter={(t) => t ? new Date(t as string).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}) : ''} tick={{fill: '#94a3b8', fontSize: 12}} stroke="#475569" />
                  <YAxis domain={[2, 10]} tick={{fill: '#94a3b8', fontSize: 12}} stroke="#475569" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc', borderRadius: '8px' }}
                     labelFormatter={(l) => l ? new Date(l as string).toLocaleTimeString() : ''} 
                  />
                  <ReferenceLine y={6.0} stroke="#10b981" strokeDasharray="3 3" label={{position: 'insideBottomRight', value: 'Min 6.0', fill: '#10b981', fontSize: 12}} />
                  <ReferenceLine y={9.0} stroke="#10b981" strokeDasharray="3 3" label={{position: 'insideTopRight', value: 'Max 9.0', fill: '#10b981', fontSize: 12}} />
                  <Line type="monotone" dataKey="ph_in" name="IN" stroke="#64748b" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ph_out" name="OUT" stroke="#3b82f6" strokeWidth={3} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: CONTROLS */}
        <div className="space-y-6">
          
          {/* BATCH CONFIGURATION */}
          <div className={`p-6 rounded-2xl border shadow-xl transition-all duration-500 ${isProcessActive ? 'bg-slate-800 border-blue-500/30 ring-1 ring-blue-500/20' : 'bg-slate-800 border-slate-700'}`}>
            <h2 className="text-lg font-bold mb-6 flex items-center gap-2 border-b border-slate-700 pb-3 text-slate-200">
              <Settings size={20} className={isProcessActive ? "text-blue-500 animate-spin-slow" : "text-slate-400"}/> 
              Batch Automation
            </h2>
            
            <div className="space-y-5 mb-8">
              {/* Coagulation */}
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3 flex justify-between">
                  <span>Phase 1: Coagulation</span>
                  {currentPhase === 'COAGULATION' && <span className="text-amber-400 animate-pulse font-mono">{formatTime(liveRemainingSec)}</span>}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Speed (%)</label>
                    <input type="number" min="0" max="100" disabled={isProcessActive}
                      value={inputConfig.coag_pwm_pct} onChange={(e) => handleNumberInput('coag_pwm_pct', e.target.value)}
                      className="w-full mt-1 p-2 border border-slate-600 rounded-lg bg-slate-800 text-white disabled:opacity-40" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Time (Min)</label>
                    <input type="number" min="1" disabled={isProcessActive}
                      value={inputConfig.coag_duration_min} onChange={(e) => handleNumberInput('coag_duration_min', e.target.value)}
                      className="w-full mt-1 p-2 border border-slate-600 rounded-lg bg-slate-800 text-white disabled:opacity-40" />
                  </div>
                </div>
              </div>

              {/* Flocculation */}
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                 <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3 flex justify-between">
                  <span>Phase 2: Flocculation</span>
                  {currentPhase === 'FLOCCULATION' && <span className="text-amber-400 animate-pulse font-mono">{formatTime(liveRemainingSec)}</span>}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Speed (%)</label>
                    <input type="number" min="0" max="100" disabled={isProcessActive}
                      value={inputConfig.floc_pwm_pct} onChange={(e) => handleNumberInput('floc_pwm_pct', e.target.value)}
                      className="w-full mt-1 p-2 border border-slate-600 rounded-lg bg-slate-800 text-white disabled:opacity-40" />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Time (Min)</label>
                    <input type="number" min="1" disabled={isProcessActive}
                      value={inputConfig.floc_duration_min} onChange={(e) => handleNumberInput('floc_duration_min', e.target.value)}
                      className="w-full mt-1 p-2 border border-slate-600 rounded-lg bg-slate-800 text-white disabled:opacity-40" />
                  </div>
                </div>
              </div>

              {/* Sedimentation */}
               <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                 <p className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-3 flex justify-between">
                  <span>Phase 3: Sedimentation</span>
                  {currentPhase === 'SEDIMENTATION' && <span className="text-amber-400 animate-pulse font-mono">{formatTime(liveRemainingSec)}</span>}
                </p>
                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase">Settling Time (Min)</label>
                  <input type="number" min="1" disabled={isProcessActive}
                    value={inputConfig.sediment_duration_min} onChange={(e) => handleNumberInput('sediment_duration_min', e.target.value)}
                    className="w-full mt-1 p-2 border border-slate-600 rounded-lg bg-slate-800 text-white disabled:opacity-40" />
                </div>
              </div>
            </div>

            {isProcessActive ? (
              <button onClick={() => sendBatchCommand('STOP')} className="w-full bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/50 font-bold py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all">
                <Square size={20} className="fill-current"/> Stop Process
              </button>
            ) : (
              <button onClick={() => sendBatchCommand('START')} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(37,99,235,0.3)] hover:shadow-[0_0_30px_rgba(37,99,235,0.5)] border border-blue-500">
                <Play size={20} className="fill-current"/> Start Processing
              </button>
            )}
          </div>

          {/* TRANSFER PUMP CONTROL */}
          <div className={`p-6 rounded-2xl border shadow-xl transition-all duration-500 ${currentPhase === 'COMPLETED' ? 'bg-slate-800 border-emerald-500/50 ring-1 ring-emerald-500/20' : 'bg-slate-800 border-slate-700'}`}>
            <h2 className="text-lg font-bold mb-2 flex items-center justify-between border-b border-slate-700 pb-3 text-slate-200">
              <span className="flex items-center gap-2"><Settings2 size={20} className="text-emerald-500"/> Transfer Pump</span>
              {currentPhase === 'COMPLETED' && <span className="bg-emerald-500/20 text-emerald-400 text-xs px-2 py-1 rounded font-bold animate-pulse">READY</span>}
            </h2>
            <p className="text-xs text-slate-400 mb-6 leading-relaxed mt-3">Ensure the manual valve is opened and sedimentation is complete before running the pump to Chamber 4.</p>
            
            <div className="mb-6 bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
              <label className="flex justify-between text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">
                <span>Flow Rate (%)</span>
                <span className="text-emerald-400">{inputConfig.pump_pwm_pct || 0}%</span>
              </label>
              <input type="range" min="0" max="100" step="1"
                value={inputConfig.pump_pwm_pct || 0}
                onChange={(e) => setInputConfig({...inputConfig, pump_pwm_pct: parseInt(e.target.value)})}
                onMouseUp={() => setPumpPWM(inputConfig.pump_pwm_pct)}
                onTouchEnd={() => setPumpPWM(inputConfig.pump_pwm_pct)}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
            </div>

            <div className="flex gap-2">
              <button onClick={() => setPumpPWM(0)} className={`flex-1 py-3 rounded-xl font-bold border transition-all text-xs uppercase tracking-wider ${inputConfig.pump_pwm_pct === 0 ? 'bg-rose-500/20 border-rose-500/50 text-rose-400' : 'bg-slate-800 border-slate-600 text-slate-400 hover:bg-slate-700'}`}>
                Off
              </button>
              <button onClick={() => setPumpPWM(50)} className={`flex-1 py-3 rounded-xl font-bold border transition-all text-xs uppercase tracking-wider ${inputConfig.pump_pwm_pct === 50 ? 'bg-blue-500/20 border-blue-500/50 text-blue-400' : 'bg-slate-800 border-slate-600 text-slate-400 hover:bg-slate-700'}`}>
                Half
              </button>
              <button onClick={() => setPumpPWM(100)} className={`flex-1 py-3 rounded-xl font-bold border transition-all text-xs uppercase tracking-wider ${inputConfig.pump_pwm_pct === 100 ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-slate-800 border-slate-600 text-slate-400 hover:bg-slate-700'}`}>
                Full
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {/* Custom Styles for Slider & Animations */}
      <style dangerouslySetInnerHTML={{__html: `
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 20px;
          width: 20px;
          border-radius: 50%;
          background: #10b981;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.5);
        }
        .animate-spin-slow {
          animation: spin 3s linear infinite;
        }
      `}} />
    </div>
  );
}