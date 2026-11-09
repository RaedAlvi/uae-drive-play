// M-2 roadside data for pakistan.html only, generated from build/pk/research/m2_corridor.json and
// build/pk/m2_corridor.json. Names and Urdu are the file's own (OpenStreetMap name and name:ur); kilometres
// are chainage computed from OpenStreetMap carriageway geometry, not official National Highway Authority figures.
// Corridor boxes: [south, west, north, east], the last two added by hand for the stretch inside the twin-cities and Lahore road boxes.
export const M2_BOXES = [[33.281, 72.765, 33.411, 72.832], [33.175, 72.649, 33.305, 72.788], [33.07, 72.611, 33.197, 72.672], [32.962, 72.617, 33.091, 72.68], [32.857, 72.638, 32.986, 72.696], [32.75, 72.639, 32.879, 72.749], [32.644, 72.725, 32.774, 72.773], [32.538, 72.726, 32.668, 72.827], [32.44, 72.804, 32.561, 72.903], [32.386, 72.88, 32.463, 72.979], [32.31, 72.956, 32.409, 73.03], [32.235, 73.006, 32.334, 73.044], [32.16, 73.019, 32.259, 73.058], [32.084, 73.034, 32.183, 73.082], [32.008, 73.058, 32.106, 73.103], [31.933, 73.079, 32.032, 73.162], [31.922, 73.139, 31.957, 73.246], [31.915, 73.223, 31.946, 73.329], [31.909, 73.307, 31.938, 73.413], [31.904, 73.391, 31.933, 73.498], [31.896, 73.475, 31.929, 73.581], [31.866, 73.559, 31.92, 73.665], [31.833, 73.641, 31.89, 73.748], [31.803, 73.725, 31.856, 73.832], [31.773, 73.81, 31.826, 73.917], [31.738, 73.894, 31.797, 74.001], [31.726, 73.978, 31.762, 74.084], [31.689, 74.062, 31.749, 74.169], [33.41, 72.83, 33.6, 72.93], [31.53, 74.18, 31.7, 74.27]];
// [name, urdu ('' when none is sourced), lat, lon, chainage km, 0 interchange / 1 service area]. Interchanges come first, in chainage order.
export const M2_NODES = [
  ["Islamabad / M-1 Interchange", "اسلام آباد/ایم ۱ انٹرچینج", 33.59111, 72.86937, 0.0, 0],
  ["Thalian Interchange", "ٹھلیاں انٹرچینج", 33.53407, 72.89888, 7.5, 0],
  ["Chakri Interchange", "چکری انٹر چینج", 33.30872, 72.77896, 36.5, 0],
  ["Neela Dullah Interchange", "نیلہ دُلہہ انٹرچینج", 33.16532, 72.65254, 57.3, 0],
  ["Balkasar Interchange", "بلکسر انٹرچینج", 32.93592, 72.68199, 85.6, 0],
  ["Kallar Kahar Interchange", "کلر کہار انٹرچینج", 32.77305, 72.71914, 109.3, 0],
  ["Lillah Interchange", "للّہ انٹرچینج", 32.57897, 72.80019, 136.8, 0],
  ["Bhera Interchange", "بھیرہ انٹرچینج", 32.46281, 72.87585, 151.8, 0],
  ["Salam Interchange", "سالم انٹرچینج", 32.31789, 73.0205, 173.5, 0],
  ["Kot Momin Interchange", "کوٹ مومن انٹرچینج", 32.19177, 73.03616, 187.8, 0],
  ["Sial Mor Interchange", "سیال موڑ انٹرچینج", 31.97722, 73.10849, 212.9, 0],
  ["Pindi Bhattian Interchange", "پنڈی بھٹیاں انٹرچینج", 31.92999, 73.28796, 231.4, 0],
  ["Faisalabad Multan Interchange", "", 31.92586, 73.32578, 235.1, 0],
  ["Kot Sarwar Sukheki Interchange", "کوٹ سرور سُکھیکی انٹرچینج", 31.91611, 73.50092, 251.7, 0],
  ["Khanqah Dogran Interchange", "خانقاہ ڈوگراں انٹرچینج", 31.87062, 73.67002, 268.7, 0],
  ["Hiran Minar Interchange", "ہرن مینار انٹرچینج", 31.7639, 73.95322, 298.2, 0],
  ["Sheikhupura Interchange", "شیخوپورہ انٹرچینج", 31.74709, 74.00829, 303.7, 0],
  ["Kala Shah Kaku Interchange", "", 31.67616, 74.19832, 324.0, 0],
  ["Kot Abdul Malik Interchange", "کوٹ عبد الملک انٹرچینج", 31.63854, 74.20705, 328.4, 0],
  ["Faizpur Interchange", "فیض پور انٹرچینج", 31.59482, 74.2186, 333.4, 0],
  ["Babu Sabu Interchange", "بابو صابو انٹرچینج", 31.53898, 74.26083, 341.0, 0],
  ["Chakri Service Area", "", 33.31939, 72.785424, 35.1, 1],
  ["Motorway Service Area North, near Dhok Sial", "موٹروے سروس ایریا نارتھ", 33.00747, 72.646266, 76.7, 1],
  ["Motorway Service Area South, near Dhok Sial", "موٹروے سروس ایریا ساؤتھ", 33.007436, 72.645667, 76.7, 1],
  ["Balkasar Service Area North", "بلکسر موٹروے سروس ایریا نارتھ", 32.869675, 72.652276, 94.2, 1],
  ["Balkasar Service Area South", "بلکسر موٹروے سروس ایریا ساؤتھ", 32.870166, 72.65171, 94.2, 1],
  ["Kallar Kahar Service Area North", "کلر کہار موٹروے سروس ایریا نارتھ", 32.781016, 72.71714, 108.4, 1],
  ["Kallar Kahar Service Area South", "کلر کہار موٹروے سروس ایریا ساؤتھ", 32.76863, 72.717418, 109.7, 1],
  ["Bhera Service Area North", "بھیرہ موٹروے سروس ایریا نارتھ", 32.45568, 72.888151, 153.0, 1],
  ["Bhera Service Area South", "بھیرہ موٹروے سروس ایریا ساؤتھ", 32.453338, 72.885871, 153.2, 1],
  ["Sial Mor Service Area North", "موٹروے سروس ایریا نارتھ", 31.973655, 73.110601, 213.3, 1],
  ["Sial Mor Service Area South", "موٹروے سروس ایریا ساؤتھ", 31.96528, 73.11604, 214.3, 1],
  ["Pindi Bhattian Service Area North", "پنڈی بھٹیاں موٹروے سروس ایریا نارتھ", 31.921229, 73.392867, 241.5, 1],
  ["Pindi Bhattian Service Area South", "پنڈی بھٹیاں موٹروے سروس ایریا ساؤتھ", 31.920706, 73.392808, 241.5, 1],
  ["Sukheki Service Area North", "سُکھیکی موٹروے سروس ایریا نارتھ", 31.909882, 73.569344, 258.2, 1],
  ["Sukheki Service Area South", "سُکھیکی موٹروے سروس ایریا ساؤتھ", 31.906842, 73.567899, 258.2, 1],
];
export const M2_INTERCHANGES = M2_NODES.filter(n => n[5] === 0).length;
const MLA = 110900, MLO = 93500;
export function m2At(lat, lon) { for (const b of M2_BOXES) if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) return true; return false; }
// within r metres of an interchange or service area: the only lit stretches of the road (art_direction.md section 10)
export function m2Lit(lat, lon, r) { for (const n of M2_NODES) if (Math.hypot((lat - n[2]) * MLA, (lon - n[3]) * MLO) < r) return true; return false; }
