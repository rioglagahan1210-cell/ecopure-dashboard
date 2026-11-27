'use client';

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart } from 'recharts';
import { Droplets, Activity, Settings, Play, Square, Settings2, ShieldCheck, ShieldAlert, Power, SlidersHorizontal, CheckCircle2, Loader2, Zap } from 'lucide-react';

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
  
  const [inputConfig, setInputConfig] = useState({
    eq_pwm_pct: 60, eq_duration_min: 5,
    coag_pwm_pct: 90, coag_duration_min: 5,
    floc_pwm_pct: 35, floc_duration_min: 20,
    sediment_duration_min: 30,
    pump_active: false
  });

  const [liveRemainingSec, setLiveRemainingSec] = useState(0);
  const [eqLiveRemainingSec, setEqLiveRemainingSec] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const eqTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setIsClient(true);
    fetchInitialData();

    const sensorSub = supabase.channel('sensor-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_logs' }, (payload) => {
        setSensorLogs((prev) => [...prev, payload.new].slice(-20));
      }).subscribe();

    const deviceSub = supabase.channel('device-changes')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'device_control' }, (payload) => {
        const config = payload.new;
        setDeviceConfig(config);
        
        // Perbarui form input otomatis HANYA JIKA sistem tidak sedang berjalan
        if (config.batch_command !== 'START' && config.eq_command !== 'START') {
           setInputConfig({
            eq_pwm_pct: pwmToPercent(config.eq_pwm || 0), eq_duration_min: secToMin(config.eq_duration_sec || 0),
            coag_pwm_pct: pwmToPercent(config.coag_pwm || 0), coag_duration_min: secToMin(config.coag_duration_sec || 0),
            floc_pwm_pct: pwmToPercent(config.floc_pwm || 0), floc_duration_min: secToMin(config.floc_duration_sec || 0),
            sediment_duration_min: secToMin(config.sediment_duration_sec || 0),
            pump_active: config.pump_pwm > 0
          });
        }
      }).subscribe();

    return () => {
      supabase.removeChannel(sensorSub);
      supabase.removeChannel(deviceSub);
      if (timerRef.current) clearInterval(timerRef.current);
      if (eqTimerRef.current) clearInterval(eqTimerRef.current);
    };
  }, []);

  const fetchInitialData = async () => {
    const { data: logs } = await supabase.from('sensor_logs').select('*').order('created_at', { ascending: false }).limit(20);
    if (logs) setSensorLogs(logs.reverse());

    const { data: config } = await supabase.from('device_control').select('*').eq('id', 1).single();
    if (config) {
      setDeviceConfig(config);
      setInputConfig({
        eq_pwm_pct: pwmToPercent(config.eq_pwm || 0), eq_duration_min: secToMin(config.eq_duration_sec || 0),
        coag_pwm_pct: pwmToPercent(config.coag_pwm || 0), coag_duration_min: secToMin(config.coag_duration_sec || 0),
        floc_pwm_pct: pwmToPercent(config.floc_pwm || 0), floc_duration_min: secToMin(config.floc_duration_sec || 0),
        sediment_duration_min: secToMin(config.sediment_duration_sec || 0),
        pump_active: config.pump_pwm > 0
      });
    }
  };

  const latestData = sensorLogs[sensorLogs.length - 1] || {};
  const currentPhase = latestData.batch_phase || 'IDLE';
  const isProcessActive = deviceConfig?.batch_command === 'START' && currentPhase !== 'COMPLETED' && currentPhase !== 'IDLE';
  const isEqActive = deviceConfig?.eq_command === 'START';

  // Timer: Batch Utama (Koagulasi-Flokulasi-Sedimentasi)
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

  // Timer: Ekualisasi Mandiri
  useEffect(() => {
    if (isEqActive) {
      setEqLiveRemainingSec(inputConfig.eq_duration_min * 60);
      if (eqTimerRef.current) clearInterval(eqTimerRef.current);
      eqTimerRef.current = setInterval(() => {
        setEqLiveRemainingSec((prev) => {
          if (prev <= 1) { 
            clearInterval(eqTimerRef.current!); 
            // Matikan UI jika timer habis (ESP32 sudah otomatis mematikannya)
            setDeviceConfig((d:any) => ({...d, eq_command: 'STOP'}));
            return 0; 
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (eqTimerRef.current) clearInterval(eqTimerRef.current);
      setEqLiveRemainingSec(0);
    }
  }, [isEqActive]);

  const sendEqCommand = async (command: string) => {
    setDeviceConfig((prev: any) => ({ ...prev, eq_command: command }));
    
    if (command === 'START') {
      await supabase.from('device_control').update({
        eq_command: 'START',
        eq_pwm: percentToPwm(inputConfig.eq_pwm_pct),
        eq_duration_sec: minToSec(inputConfig.eq_duration_min),
        updated_at: new Date().toISOString()
      }).eq('id', 1);
    } else {
      await supabase.from('device_control').update({ 
        eq_command: 'STOP', updated_at: new Date().toISOString()
      }).eq('id', 1);
    }
  };

  const sendBatchCommand = async (command: string) => {
    setDeviceConfig((prev: any) => ({ ...prev, batch_command: command }));

    if (command === 'START') {
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
        batch_command: 'STOP', updated_at: new Date().toISOString()
      }).eq('id', 1);
    }
  };

  const togglePump = async () => {
    const newState = !inputConfig.pump_active;
    setInputConfig(prev => ({ ...prev, pump_active: newState }));
    await supabase.from('device_control').update({ 
      pump_pwm: newState ? 255 : 0, 
      updated_at: new Date().toISOString() 
    }).eq('id', 1);
  };

  const handleNumberInput = (field: string, val: string) => {
    const num = parseInt(val);
    setInputConfig(prev => ({ ...prev, [field]: isNaN(num) ? '' : num }));
  };

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

  if (!isClient) return null;

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8 font-sans text-slate-100">
      
      {/* EFEK LATAR BELAKANG FUTURISTIK */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-900/20 blur-[120px]"></div>
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-blue-900/20 blur-[120px]"></div>
        <div className="absolute inset-0 futuristic-grid opacity-15"></div>
      </div>

      <div className="relative z-10 p-4 md:p-8 max-w-screen-2xl mx-auto">
        
        {/* HEADER & LOGO */}
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-white/10">
          <div className="flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 bg-cyan-500 rounded-xl blur-md opacity-30 group-hover:opacity-60 transition duration-500"></div>
              <div className="relative w-14 h-14 bg-slate-900/80 backdrop-blur-sm rounded-xl border border-white/10 flex items-center justify-center p-2 shadow-[0_0_20px_rgba(6,182,212,0.15)]">
                <img src="/logo.png" alt="ECOPURE Logo" className="w-full h-full object-contain" 
                  onError={(e) => { e.currentTarget.style.display='none'; e.currentTarget.parentElement?.insertAdjacentHTML('beforeend', '<span class="text-cyan-400 font-bold text-[10px]">LOGO</span>')}} />
              </div>
            </div>
            
            <div>
              <h1 className="text-4xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 flex items-center gap-3">
                ECOPURE-BATIK
              </h1>
              <p className="text-slate-400 mt-1 tracking-[0.2em] text-[10px] font-bold uppercase flex items-center gap-2">
                <Zap size={12} className="text-cyan-400"/> Advanced Multistage Filtration
              </p>
            </div>
          </div>
          
          <div className={`px-5 py-2.5 rounded-full font-bold flex items-center gap-3 shadow-lg border backdrop-blur-md ${latestData.is_ph_safe ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-emerald-500/10' : 'bg-rose-500/10 border-rose-500/30 text-rose-400 shadow-rose-500/20 animate-pulse'}`}>
            {latestData.is_ph_safe ? <ShieldCheck size={18}/> : <ShieldAlert size={18}/>}
            <span className="tracking-wide text-xs">{latestData.is_ph_safe ? 'SYSTEM NORMAL : EFFLUENT SAFE' : 'CRITICAL ALARM : pH OUT OF RANGE'}</span>
          </div>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          
          {/* KOLOM KIRI: VISUAL & GRAFIK (8 Kolom) */}
          <div className="xl:col-span-8 space-y-8">
            
            {/* KARTU KPI (Key Performance Indicators) */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="glass-panel p-5 relative overflow-hidden group hover:border-cyan-500/50 transition-colors">
                <div className="absolute top-0 right-0 p-3 opacity-20 group-hover:opacity-40 transition-opacity"><Activity size={40} className="text-cyan-400"/></div>
                <p className="text-[10px] text-cyan-400 font-bold uppercase tracking-widest mb-1">pH IN (Chamber 1)</p>
                <p className="text-4xl font-mono font-light text-white">{latestData.ph_in?.toFixed(2) || '--'}</p>
              </div>
              
              <div className={`glass-panel p-5 relative overflow-hidden transition-all ${!latestData.is_ph_safe ? 'border-rose-500/50 shadow-[0_0_20px_rgba(244,63,94,0.2)]' : 'hover:border-blue-500/50'}`}>
                <div className="absolute top-0 right-0 p-3 opacity-20"><Droplets size={40} className={!latestData.is_ph_safe ? "text-rose-400" : "text-blue-400"}/></div>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${!latestData.is_ph_safe ? "text-rose-400" : "text-blue-400"}`}>pH OUT (Chamber 5)</p>
                <p className="text-4xl font-mono font-light text-white">{latestData.ph_out?.toFixed(2) || '--'}</p>
              </div>

              <div className="glass-panel p-5 flex flex-col justify-center relative overflow-hidden hover:border-purple-500/50 transition-colors">
                <p className="text-[10px] text-purple-400 font-bold uppercase tracking-widest mb-1">Active Stage</p>
                <p className="text-sm font-bold tracking-wider text-slate-200 uppercase truncate">{isEqActive ? "EQUALIZATION" : currentPhase}</p>
                {(isProcessActive || isEqActive) && (
                  <p className="text-2xl font-mono font-bold text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-orange-400 mt-1 drop-shadow-md">
                    {isEqActive ? formatTime(eqLiveRemainingSec) : formatTime(liveRemainingSec)}
                  </p>
                )}
              </div>

              <div className="glass-panel p-4 flex flex-col justify-between relative hover:border-emerald-500/50 transition-colors">
                <p className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest mb-2">Actuators Telemetry</p>
                <div className="space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between items-center bg-white/5 px-2 py-1 rounded"><span className="text-slate-400 font-sans text-[10px] uppercase">Mix EQ</span><span className="text-purple-400 font-bold">{pwmToPercent(latestData.mixer2_pwm || 0)}%</span></div>
                  <div className="flex justify-between items-center bg-white/5 px-2 py-1 rounded"><span className="text-slate-400 font-sans text-[10px] uppercase">Mix KF</span><span className="text-cyan-400 font-bold">{pwmToPercent(latestData.mixer_pwm || 0)}%</span></div>
                  <div className="flex justify-between items-center bg-white/5 px-2 py-1 rounded border border-white/5"><span className="text-slate-400 font-sans text-[10px] uppercase">Pump</span>
                    <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${latestData.pump_pwm > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-500'}`}>{latestData.pump_pwm > 0 ? 'ACTIVE' : 'IDLE'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* GRAFIK REAL-TIME AREA CHART */}
            <div className="glass-panel p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xs font-bold tracking-widest uppercase flex items-center gap-3 text-slate-300">
                  <Activity size={18} className="text-cyan-500"/> Live pH Telemetry
                </h2>
                <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500 shadow-[0_0_5px_#64748b]"></span> Inlet</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_#3b82f6]"></span> Outlet</span>
                </div>
              </div>
              <div className="h-[350px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={sensorLogs} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorPhOut" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)"/>
                    <XAxis dataKey="created_at" tickFormatter={(t) => t ? new Date(t as string).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}) : ''} tick={{fill: '#64748b', fontSize: 11, fontFamily: 'monospace'}} stroke="rgba(255,255,255,0.1)" />
                    <YAxis domain={[2, 10]} tick={{fill: '#64748b', fontSize: 11, fontFamily: 'monospace'}} stroke="rgba(255,255,255,0.1)" />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(10px)', borderColor: 'rgba(255,255,255,0.1)', color: '#f8fafc', borderRadius: '12px', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)' }}
                      labelFormatter={(l) => l ? new Date(l as string).toLocaleTimeString() : ''} 
                    />
                    <ReferenceLine y={6.0} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} label={{position: 'insideBottomRight', value: 'MIN LIMIT 6.0', fill: '#10b981', fontSize: 10, fontWeight: 'bold'}} />
                    <ReferenceLine y={9.0} stroke="#10b981" strokeDasharray="3 3" strokeOpacity={0.5} label={{position: 'insideTopRight', value: 'MAX LIMIT 9.0', fill: '#10b981', fontSize: 10, fontWeight: 'bold'}} />
                    <Area type="monotone" dataKey="ph_out" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorPhOut)" isAnimationActive={false} />
                    <Line type="monotone" dataKey="ph_in" stroke="#64748b" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* PROGRESS STEPPER */}
            <div className="glass-panel p-6 overflow-hidden relative">
               <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-6 text-center">Storage 2 Processing Pipeline</p>
               <div className="flex items-center justify-between min-w-[500px] px-8 relative z-10">
                 {/* Garis konektor */}
                 <div className="absolute top-1/2 left-10 right-10 h-1 bg-slate-800 -translate-y-1/2 z-0"></div>
                 {[
                   { step: 1, name: 'Coagulation' },
                   { step: 2, name: 'Flocculation' },
                   { step: 3, name: 'Sedimentation' },
                   { step: 4, name: 'Completion' },
                 ].map((item, idx) => {
                    const isPast = phaseIdx > item.step;
                    const isActive = phaseIdx === item.step && isProcessActive;
                    return (
                      <div key={item.step} className="flex flex-col items-center gap-3 z-10 w-24">
                        <div className="relative group">
                          {isActive && <div className="absolute inset-0 bg-blue-500 rounded-full animate-ping opacity-50"></div>}
                          <div className={`relative w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm border-[3px] transition-all duration-500 backdrop-blur-sm 
                            ${isActive ? 'bg-slate-900 border-blue-500 text-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.6)]' 
                            : isPast ? 'bg-slate-900 border-emerald-500 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.3)]' 
                            : 'bg-slate-900 border-slate-700 text-slate-600'}`}>
                            {isPast ? <CheckCircle2 size={20}/> : isActive ? <Loader2 size={20} className="animate-spin"/> : item.step}
                          </div>
                        </div>
                        <span className={`text-[10px] font-bold uppercase tracking-wider text-center ${isActive ? 'text-blue-400 drop-shadow-[0_0_5px_rgba(59,130,246,0.8)]' : isPast ? 'text-emerald-500' : 'text-slate-600'}`}>{item.name}</span>
                      </div>
                    )
                 })}
               </div>
            </div>
          </div>

          {/* KOLOM KANAN: PANEL KENDALI (4 Kolom) */}
          <div className="xl:col-span-4 space-y-6">
            
            {/* PANEL 1: EKUALISASI MANDIRI */}
            <div className={`glass-panel p-6 relative overflow-hidden transition-all duration-500 ${isEqActive ? 'border-purple-500/50 shadow-[0_0_30px_rgba(168,85,247,0.15)]' : ''}`}>
              {isEqActive && <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-600 to-fuchsia-500 animate-pulse"></div>}
              
              <h2 className="text-xs font-bold tracking-widest uppercase mb-6 flex items-center gap-3 text-slate-300">
                <SlidersHorizontal size={16} className={isEqActive ? "text-purple-400" : "text-slate-500"}/> 
                Storage 1: Equalization
              </h2>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="input-group">
                  <label>Mixer Speed (%)</label>
                  <input type="number" min="0" max="100" disabled={isEqActive} value={inputConfig.eq_pwm_pct} onChange={(e) => handleNumberInput('eq_pwm_pct', e.target.value)} />
                </div>
                <div className="input-group">
                  <label>Duration (Min)</label>
                  <input type="number" min="1" disabled={isEqActive} value={inputConfig.eq_duration_min} onChange={(e) => handleNumberInput('eq_duration_min', e.target.value)} />
                </div>
              </div>
              {isEqActive ? (
                <button onClick={() => sendEqCommand('STOP')} className="btn-stop">
                  <Square size={14} className="fill-current"/> ABORT EQUALIZATION
                </button>
              ) : (
                <button onClick={() => sendEqCommand('START')} className="btn-start from-purple-600 to-fuchsia-600 shadow-purple-500/30">
                  <Play size={14} className="fill-current"/> INITIATE EQUALIZATION
                </button>
              )}
            </div>

            {/* PANEL 2: SIKLUS BATCH OTOMATIS */}
            <div className={`glass-panel p-6 relative overflow-hidden transition-all duration-500 flex flex-col ${isProcessActive ? 'border-blue-500/50 shadow-[0_0_30px_rgba(59,130,246,0.15)]' : ''}`}>
              {isProcessActive && <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 to-cyan-400 animate-pulse"></div>}

              <h2 className="text-xs font-bold tracking-widest uppercase mb-5 flex items-center gap-3 text-slate-300">
                <Settings size={16} className={isProcessActive ? "text-cyan-400 animate-spin-slow" : "text-slate-500"}/> 
                Storage 2: Filtration Pipeline
              </h2>
              
              <div className="space-y-4 mb-6 flex-1 max-h-[300px] overflow-y-auto pr-3 custom-scrollbar">
                
                <div className={`p-4 rounded-xl border transition-colors ${currentPhase === 'COAGULATION' ? 'bg-blue-900/20 border-blue-500/30' : 'bg-white/5 border-white/5'}`}>
                  <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex justify-between ${currentPhase === 'COAGULATION' ? 'text-blue-400' : 'text-slate-500'}`}>
                    <span>1. Coagulation</span>
                    {currentPhase === 'COAGULATION' && <span className="animate-pulse">{formatTime(liveRemainingSec)}</span>}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="input-group"><label>Speed (%)</label><input type="number" min="0" max="100" disabled={isProcessActive} value={inputConfig.coag_pwm_pct} onChange={(e) => handleNumberInput('coag_pwm_pct', e.target.value)} /></div>
                    <div className="input-group"><label>Time (Min)</label><input type="number" min="1" disabled={isProcessActive} value={inputConfig.coag_duration_min} onChange={(e) => handleNumberInput('coag_duration_min', e.target.value)} /></div>
                  </div>
                </div>

                <div className={`p-4 rounded-xl border transition-colors ${currentPhase === 'FLOCCULATION' ? 'bg-blue-900/20 border-blue-500/30' : 'bg-white/5 border-white/5'}`}>
                   <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex justify-between ${currentPhase === 'FLOCCULATION' ? 'text-blue-400' : 'text-slate-500'}`}>
                    <span>2. Flocculation</span>
                    {currentPhase === 'FLOCCULATION' && <span className="animate-pulse">{formatTime(liveRemainingSec)}</span>}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="input-group"><label>Speed (%)</label><input type="number" min="0" max="100" disabled={isProcessActive} value={inputConfig.floc_pwm_pct} onChange={(e) => handleNumberInput('floc_pwm_pct', e.target.value)} /></div>
                    <div className="input-group"><label>Time (Min)</label><input type="number" min="1" disabled={isProcessActive} value={inputConfig.floc_duration_min} onChange={(e) => handleNumberInput('floc_duration_min', e.target.value)} /></div>
                  </div>
                </div>

                 <div className={`p-4 rounded-xl border transition-colors ${currentPhase === 'SEDIMENTATION' ? 'bg-blue-900/20 border-blue-500/30' : 'bg-white/5 border-white/5'}`}>
                   <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 flex justify-between ${currentPhase === 'SEDIMENTATION' ? 'text-blue-400' : 'text-slate-500'}`}>
                    <span>3. Sedimentation</span>
                    {currentPhase === 'SEDIMENTATION' && <span className="animate-pulse">{formatTime(liveRemainingSec)}</span>}
                  </p>
                  <div className="input-group"><label>Settling Time (Min)</label><input type="number" min="1" disabled={isProcessActive} value={inputConfig.sediment_duration_min} onChange={(e) => handleNumberInput('sediment_duration_min', e.target.value)} /></div>
                </div>
              </div>

              {isProcessActive ? (
                <button onClick={() => sendBatchCommand('STOP')} className="btn-stop mt-auto">
                  <Square size={14} className="fill-current"/> SYSTEM OVERRIDE: STOP
                </button>
              ) : (
                <button onClick={() => sendBatchCommand('START')} className="btn-start from-blue-600 to-cyan-600 shadow-cyan-500/30 mt-auto">
                  <Play size={14} className="fill-current"/> EXECUTE BATCH PIPELINE
                </button>
              )}
            </div>

            {/* PANEL 3: POMPA TRANSFER */}
            <div className={`glass-panel p-6 transition-all duration-500 ${inputConfig.pump_active ? 'border-emerald-500/50 shadow-[0_0_30px_rgba(16,185,129,0.15)]' : ''}`}>
              <h2 className="text-xs font-bold tracking-widest uppercase mb-4 flex items-center justify-between text-slate-300">
                <span className="flex items-center gap-3"><Settings2 size={16} className={inputConfig.pump_active ? "text-emerald-400 animate-spin-slow" : "text-slate-500"}/> Storage 3: Transfer</span>
                {currentPhase === 'COMPLETED' && <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/30 animate-pulse">READY</span>}
              </h2>
              
              <button onClick={togglePump} className={`w-full relative overflow-hidden group py-5 rounded-xl font-bold border transition-all uppercase tracking-widest text-xs flex items-center justify-center gap-3 
                ${inputConfig.pump_active 
                ? 'bg-emerald-900/40 border-emerald-500/50 text-emerald-300 shadow-[inset_0_0_20px_rgba(16,185,129,0.2)]' 
                : 'bg-slate-900 border-white/10 text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
                {inputConfig.pump_active && <div className="absolute inset-0 bg-emerald-500/10 w-full h-full animate-pulse pointer-events-none"></div>}
                <Power size={18} className={inputConfig.pump_active ? "text-emerald-400" : "text-slate-600"}/>
                {inputConfig.pump_active ? 'PUMP ACTIVE' : 'ENGAGE PUMP'}
              </button>
            </div>

          </div>
        </div>
      </div>
      
      {/* GLOBAL CSS STYLES FOR FUTURISTIC UI */}
      <style dangerouslySetInnerHTML={{__html: `
        .glass-panel {
          background: rgba(30, 41, 59, 0.4);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 1.25rem;
        }
        .futuristic-grid {
          background-size: 40px 40px;
          background-image: 
            linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px);
          mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 20%, transparent 100%);
          -webkit-mask-image: radial-gradient(ellipse 80% 80% at 50% 50%, black 20%, transparent 100%);
        }
        .input-group label {
          display: block;
          font-size: 0.65rem;
          font-weight: 700;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 0.25rem;
        }
        .input-group input {
          width: 100%;
          padding: 0.6rem 0.75rem;
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          color: white;
          font-family: monospace;
          font-size: 0.875rem;
          transition: all 0.2s;
        }
        .input-group input:focus {
          outline: none;
          border-color: #06b6d4;
          box-shadow: 0 0 10px rgba(6, 182, 212, 0.3);
        }
        .input-group input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .btn-start {
          background-image: linear-gradient(to right, var(--tw-gradient-stops));
          color: white;
          padding: 1rem;
          border-radius: 0.75rem;
          font-size: 0.75rem;
          letter-spacing: 0.1em;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 0.5rem;
          box-shadow: 0 10px 20px -5px var(--tw-shadow-color);
          position: relative;
          overflow: hidden;
        }
        .btn-start::after {
          content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
          background: linear-gradient(to right, transparent, rgba(255,255,255,0.2), transparent);
          transition: all 0.5s;
        }
        .btn-start:hover::after { left: 100%; }
        
        .btn-stop {
          background: rgba(225, 29, 72, 0.1);
          border: 1px solid rgba(226, 29, 72, 0.4);
          color: #fb7185;
          padding: 1rem;
          border-radius: 0.75rem;
          font-size: 0.75rem;
          letter-spacing: 0.1em;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 0.5rem;
        }
        .btn-stop:hover {
          background: rgba(225, 29, 72, 0.2);
          box-shadow: inset 0 0 15px rgba(225, 29, 72, 0.2);
        }
        .animate-spin-slow { animation: spin 4s linear infinite; }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}} />
    </div>
  );
}