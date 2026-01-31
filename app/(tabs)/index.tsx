import { Buffer } from "buffer";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    Platform,
    Pressable,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import Svg, { Line, Rect } from "react-native-svg";

const jpeg = require("jpeg-js");

type StripeRect = { x: number; y: number; width: number; height: number };
type ZebraResult = {
  crosswalk: boolean;
  stripes: StripeRect[];
  score: number;
  peaks: number;
  troughRatio: number;
  drift: "left" | "right" | "center" | "unknown";
};

export default function Index() {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  // App state
  const [running, setRunning] = useState(true);
  const [status, setStatus] = useState<"no_crosswalk" | "crosswalk">("no_crosswalk");
  const [score, setScore] = useState(0);
  const [peaks, setPeaks] = useState(0);
  const [troughRatio, setTroughRatio] = useState(0);
  const [drift, setDrift] = useState<ZebraResult["drift"]>("unknown");

  // UI settings
  const [showDebug, setShowDebug] = useState(true);
  const [intervalMs, setIntervalMs] = useState(750); // burst rate
  const [roiStart, setRoiStart] = useState(0.30); // fraction of height
  const [resizeW, setResizeW] = useState(320); // detection resolution
  const [expandedSettings, setExpandedSettings] = useState(false);

  // Overlay scaling
  const imgWRef = useRef(320);
  const imgHRef = useRef(240);

  // Loop locks / stability
  const busyRef = useRef(false);
  const stableCountRef = useRef(0);
  const lastTickRef = useRef<number>(0);
  const [perf, setPerf] = useState("");

  // Detected stripes (for overlay)
  const [stripes, setStripes] = useState<StripeRect[]>([]);

  // Request permission
  useEffect(() => {
    if (!permission) return;
    if (!permission.granted) requestPermission();
  }, [permission, requestPermission]);

  // Detection loop
  useEffect(() => {
    let timer: any;

    const tick = async () => {
      if (!running || !cameraRef.current) {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      if (busyRef.current) {
        timer = setTimeout(tick, 120);
        return;
      }

      busyRef.current = true;
      const t0 = Date.now();

      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.2,
          base64: true,
          skipProcessing: true,
        });
        if (!photo.base64) throw new Error("No base64");

        const resized = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: resizeW } }],
          { compress: 0.35, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );
        if (!resized.base64) throw new Error("No resized base64");

        const img = decodeJpegToRgba(resized.base64);
        imgWRef.current = img.width;
        imgHRef.current = img.height;

        const result = detectZebraProjection(img, roiStart);

        setStripes(result.stripes);
        setScore(result.score);
        setPeaks(result.peaks);
        setTroughRatio(result.troughRatio);
        setDrift(result.drift);

        // Stability gating: require 2 consecutive "true"
        if (result.crosswalk) stableCountRef.current += 1;
        else stableCountRef.current = 0;

        const stable = stableCountRef.current >= 2;
        setStatus(stable ? "crosswalk" : "no_crosswalk");

        const dt = Date.now() - t0;
        const interval = lastTickRef.current ? t0 - lastTickRef.current : 0;
        lastTickRef.current = t0;
        setPerf(`loop ${dt}ms | interval ${interval}ms`);
      } catch {
        // ignore transient errors
      } finally {
        busyRef.current = false;
        timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => timer && clearTimeout(timer);
  }, [running, intervalMs, roiStart, resizeW]);

  // Derived UI
  const statusLabel = status === "crosswalk" ? "Crosswalk detected" : "Not detected";
  const statusColor = status === "crosswalk" ? "rgba(40,200,120,0.92)" : "rgba(240,80,80,0.92)";
  const guidance = useMemo(() => {
    if (status !== "crosswalk") return "Point camera toward the ground. Look for a zebra crosswalk.";
    if (drift === "center") return "On track — keep walking straight.";
    if (drift === "left") return "Drifting left — move slightly right.";
    if (drift === "right") return "Drifting right — move slightly left.";
    return "Crosswalk detected — keep walking.";
  }, [status, drift]);

  // Permission screens (no hooks below these returns)
  if (!permission) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Requesting camera permission…</Text>
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera permission required</Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  const W = imgWRef.current;
  const H = imgHRef.current;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.container}>
        <CameraView
          ref={(r) => (cameraRef.current = r)}
          style={StyleSheet.absoluteFill}
          facing="back"
          animateShutter={false}
        />

        {/* Overlay */}
        {showDebug && (
          <Svg style={StyleSheet.absoluteFill}>
            <Line x1="50%" y1="0" x2="50%" y2="100%" stroke="cyan" strokeWidth="2" />
            {stripes.map((r, i) => (
              <Rect
                key={i}
                x={`${(r.x / W) * 100}%`}
                y={`${(r.y / H) * 100}%`}
                width={`${(r.width / W) * 100}%`}
                height={`${(r.height / H) * 100}%`}
                stroke="yellow"
                strokeWidth="2"
                fill="transparent"
              />
            ))}
            {/* ROI guide */}
            <Rect
              x="0%"
              y={`${roiStart * 100}%`}
              width="100%"
              height={`${(1 - roiStart) * 100}%`}
              stroke="rgba(0,255,255,0.35)"
              strokeWidth="2"
              fill="transparent"
            />
          </Svg>
        )}

        {/* Top HUD */}
        <View style={styles.topHud}>
          <View style={[styles.statusPill, { backgroundColor: statusColor }]}>
            <Text style={styles.statusText}>{statusLabel}</Text>
          </View>

          <View style={styles.metricsRow}>
            <Metric label="Confidence" value={score.toFixed(2)} />
            <Metric label="Peaks" value={String(peaks)} />
            <Metric label="Gaps" value={troughRatio.toFixed(2)} />
          </View>

          <ConfidenceBar value={score} />
        </View>

        {/* Bottom panel */}
        <View style={styles.bottomPanel}>
          <Text style={styles.guidanceTitle}>Guidance</Text>
          <Text style={styles.guidanceText}>{guidance}</Text>

          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.primaryBtn, { flex: 1 }]}
              onPress={() => setRunning((v) => !v)}
            >
              <Text style={styles.primaryBtnText}>{running ? "Pause" : "Start"}</Text>
            </Pressable>

            <Pressable
              style={[styles.secondaryBtn, { flex: 1 }]}
              onPress={() => setShowDebug((v) => !v)}
            >
              <Text style={styles.secondaryBtnText}>{showDebug ? "Hide Debug" : "Show Debug"}</Text>
            </Pressable>
          </View>

          <Pressable
            style={styles.settingsToggle}
            onPress={() => setExpandedSettings((v) => !v)}
          >
            <Text style={styles.settingsToggleText}>
              {expandedSettings ? "Hide settings" : "Show settings"}
            </Text>
            <Text style={styles.settingsSubText}>{perf}</Text>
          </Pressable>

          {expandedSettings && (
            <ScrollView style={styles.settingsBox} contentContainerStyle={{ paddingBottom: 6 }}>
              <SettingRow
                title="Detection interval"
                subtitle="Lower is faster but more battery/heat"
                value={`${intervalMs} ms`}
                onMinus={() => setIntervalMs((v) => Math.min(1500, Math.max(350, v + 100)))}
                onPlus={() => setIntervalMs((v) => Math.min(1500, Math.max(350, v - 100)))}
                minusLabel="+100"
                plusLabel="-100"
              />

              <SettingRow
                title="ROI start"
                subtitle="Higher means focus more on bottom of image"
                value={`${Math.round(roiStart * 100)}%`}
                onMinus={() => setRoiStart((v) => Math.max(0.15, Math.min(0.60, +(v - 0.05).toFixed(2))))}
                onPlus={() => setRoiStart((v) => Math.max(0.15, Math.min(0.60, +(v + 0.05).toFixed(2))))}
                minusLabel="-5%"
                plusLabel="+5%"
              />

              <SettingRow
                title="Resize width"
                subtitle="Higher improves detection but slower"
                value={`${resizeW}px`}
                onMinus={() => setResizeW((v) => Math.max(192, v - 64))}
                onPlus={() => setResizeW((v) => Math.min(448, v + 64))}
                minusLabel="-64"
                plusLabel="+64"
              />

              <Text style={styles.tip}>
                Tuning tips: If you get too few peaks, lower ROI start (e.g. 25–30%) or raise resize
                width (e.g. 384). If you get false positives indoors, raise ROI start (40–55%).
              </Text>
            </ScrollView>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

/* ---------- Small UI components ---------- */

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <View style={styles.barOuter}>
      <View style={[styles.barInner, { width: `${clamped * 100}%` }]} />
    </View>
  );
}

function SettingRow(props: {
  title: string;
  subtitle: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  minusLabel: string;
  plusLabel: string;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingTitle}>{props.title}</Text>
        <Text style={styles.settingSub}>{props.subtitle}</Text>
      </View>

      <View style={styles.settingControls}>
        <Pressable style={styles.miniBtn} onPress={props.onMinus}>
          <Text style={styles.miniBtnText}>{props.minusLabel}</Text>
        </Pressable>

        <Text style={styles.settingValue}>{props.value}</Text>

        <Pressable style={styles.miniBtn} onPress={props.onPlus}>
          <Text style={styles.miniBtnText}>{props.plusLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ---------- Image decode + detection ---------- */

function decodeJpegToRgba(base64Jpeg: string): { width: number; height: number; data: Uint8Array } {
  const buf = Buffer.from(base64Jpeg, "base64");
  return jpeg.decode(buf, { useTArray: true });
}

/**
 * Projection-based zebra detector (robust to worn paint + shadows)
 * Returns stripe rectangles spanning full width around peak rows.
 */
function detectZebraProjection(
  img: { width: number; height: number; data: Uint8Array },
  roiStartFrac: number
): ZebraResult {
  const { width: W, height: H, data } = img;

  const y0 = Math.floor(H * roiStartFrac);
  const y1 = H;

  const samplesX = 72;
  const stepX = Math.max(1, Math.floor(W / samplesX));

  // Row mean (ROI)
  const rowMean = new Array<number>(H).fill(0);
  let roiSum = 0;
  let roiCount = 0;

  for (let y = y0; y < y1; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < W; x += stepX) {
      const i = (y * W + x) * 4;
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += l;
      n++;
    }
    const m = sum / n;
    rowMean[y] = m;
    roiSum += m;
    roiCount++;
  }

  const roiMean = roiSum / Math.max(1, roiCount);

  // Row std in ROI
  let varSum = 0;
  for (let y = y0; y < y1; y++) {
    const d = rowMean[y] - roiMean;
    varSum += d * d;
  }
  const roiStd = Math.sqrt(varSum / Math.max(1, roiCount));

  // White threshold (loose)
  const whiteThresh = roiMean + 0.35 * roiStd;

  // Whiteness projection p[y]
  const p = new Array<number>(H).fill(0);
  for (let y = y0; y < y1; y++) {
    let white = 0;
    let n = 0;
    for (let x = 0; x < W; x += stepX) {
      const i = (y * W + x) * 4;
      const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (l > whiteThresh) white++;
      n++;
    }
    p[y] = white / Math.max(1, n);
  }

  // Smooth p[y]
  const smooth = p.slice();
  const k = 3;
  for (let y = y0 + k; y < y1 - k; y++) {
    let s = 0;
    for (let t = -k; t <= k; t++) s += p[y + t];
    smooth[y] = s / (2 * k + 1);
  }

  // Stats for peak threshold
  let smMean = 0;
  let smN = 0;
  for (let y = y0; y < y1; y++) {
    smMean += smooth[y];
    smN++;
  }
  smMean /= Math.max(1, smN);

  let smVar = 0;
  for (let y = y0; y < y1; y++) {
    const d = smooth[y] - smMean;
    smVar += d * d;
  }
  const smStd = Math.sqrt(smVar / Math.max(1, smN));

  // Peak threshold (tune)
  const peakThresh = smMean + 0.55 * smStd;

  // Peak pick
  const peaks: number[] = [];
  for (let y = y0 + 2; y < y1 - 2; y++) {
    const v = smooth[y];
    if (v > peakThresh && v > smooth[y - 1] && v > smooth[y + 1]) peaks.push(y);
  }

  // Merge peaks close together
  const mergedPeaks: number[] = [];
  const minGap = 7;
  for (const y of peaks) {
    const last = mergedPeaks[mergedPeaks.length - 1];
    if (last === undefined || y - last > minGap) mergedPeaks.push(y);
  }

  // Trough check between peaks
  let troughOk = 0;
  for (let i = 1; i < mergedPeaks.length; i++) {
    const mid = Math.floor((mergedPeaks[i] + mergedPeaks[i - 1]) / 2);
    if (smooth[mid] < smMean && p[mid] < 0.35) troughOk++;
  }
  const troughRatio = mergedPeaks.length >= 2 ? troughOk / (mergedPeaks.length - 1) : 0;

  const peakCount = mergedPeaks.length;
  const peakScore = Math.min(1, peakCount / 6);
  const score = 0.65 * peakScore + 0.35 * troughRatio;

  const crosswalk = peakCount >= 5 && score > 0.60;

  // Simple drift estimate:
  // If stripes are present, sample a few rows around each peak and compare brightness left vs right.
  // If left brighter => camera is left of center and user drifting right (or vice versa). This is a heuristic.
  let drift: ZebraResult["drift"] = "unknown";
  if (peakCount >= 5) {
    let leftSum = 0;
    let rightSum = 0;
    let count = 0;

    const midX = Math.floor(W / 2);
    const sampleRows = mergedPeaks.slice(0, 8);

    for (const y of sampleRows) {
      const yy = Math.max(0, Math.min(H - 1, y));
      for (let x = 0; x < W; x += stepX) {
        const i = (yy * W + x) * 4;
        const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (x < midX) leftSum += l;
        else rightSum += l;
        count++;
      }
    }

    const leftAvg = leftSum / Math.max(1, count);
    const rightAvg = rightSum / Math.max(1, count);
    const diff = leftAvg - rightAvg;

    // Deadband
    if (Math.abs(diff) < 2.0) drift = "center";
    else drift = diff > 0 ? "left" : "right";
  }

  // Overlay stripes: full-width thin rectangles around peaks
  const stripeRects: StripeRect[] = mergedPeaks.slice(0, 12).map((y) => ({
    x: 0,
    y: Math.max(y0, y - 3),
    width: W,
    height: 7,
  }));

  return { crosswalk, stripes: stripeRects, score, peaks: peakCount, troughRatio, drift };
}

/* ---------- Styles ---------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "black" },
  container: { flex: 1, backgroundColor: "black" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "black" },
  text: { color: "white", fontSize: 16 },

  topHud: {
    position: "absolute",
    top: Platform.OS === "ios" ? 10 : 10,
    left: 12,
    right: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.45)",
  },

  statusPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  statusText: { color: "white", fontWeight: "800", fontSize: 14 },

  metricsRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  metric: { flex: 1, padding: 10, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.08)" },
  metricLabel: { color: "rgba(255,255,255,0.75)", fontSize: 12 },
  metricValue: { color: "white", fontSize: 16, fontWeight: "700", marginTop: 4 },

  barOuter: {
    height: 10,
    marginTop: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  },
  barInner: { height: "100%", backgroundColor: "rgba(40,200,120,0.85)" },

  bottomPanel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: Platform.OS === "ios" ? 18 : 14,
    backgroundColor: "rgba(0,0,0,0.60)",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },

  guidanceTitle: { color: "white", fontSize: 16, fontWeight: "800" },
  guidanceText: { color: "rgba(255,255,255,0.92)", fontSize: 15, marginTop: 6, lineHeight: 20 },

  actionsRow: { flexDirection: "row", gap: 12, marginTop: 14 },

  primaryBtn: {
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { color: "black", fontWeight: "800", fontSize: 15 },

  secondaryBtn: {
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: { color: "white", fontWeight: "800", fontSize: 15 },

  settingsToggle: { marginTop: 12, paddingVertical: 8 },
  settingsToggleText: { color: "rgba(255,255,255,0.9)", fontWeight: "800" },
  settingsSubText: { color: "rgba(255,255,255,0.65)", marginTop: 4, fontSize: 12 },

  settingsBox: {
    marginTop: 8,
    maxHeight: 210,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },

  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  settingTitle: { color: "white", fontWeight: "800" },
  settingSub: { color: "rgba(255,255,255,0.65)", fontSize: 12, marginTop: 3 },

  settingControls: { flexDirection: "row", alignItems: "center", gap: 10 },
  miniBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  miniBtnText: { color: "white", fontWeight: "800", fontSize: 12 },

  settingValue: { color: "white", fontWeight: "800", width: 70, textAlign: "center" },

  tip: { color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 8, lineHeight: 16 },
});
