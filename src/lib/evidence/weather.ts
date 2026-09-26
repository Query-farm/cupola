import { quoteIdent } from '../duckdb-query';

export const WEATHER_SERVICE = 'https://vgi-open-meteo.rusty-bb6.workers.dev';
/** Cupola's test service (~/Development/vgi-cupola-test): the same weather
 *  functions, replaying recorded Open-Meteo responses, so the e2e suite never
 *  calls the real API. */
export const WEATHER_TEST_SERVICE = 'https://vgi-cupola-test.rusty-bb6.workers.dev';

/** Services whose catalog has the Open-Meteo functions the weather example calls. */
export function isWeatherService(url: string): boolean {
  return url === WEATHER_SERVICE || url === WEATHER_TEST_SERVICE;
}

/** One prepared setup statement; all report datasets share this snapshot and engine. */
export function weatherSetupSql(catalogName: string) {
  const catalog = quoteIdent(catalogName);
  return `CREATE OR REPLACE TEMP TABLE cupola_weather AS
WITH locations AS MATERIALIZED (
  SELECT inputs.role AS location_role, g.name AS city, g.country,
         g.latitude, g.longitude, g.timezone AS city_timezone
  FROM (VALUES ('primary', $city), ('comparison', $comparison_city)) AS inputs(role, query),
       LATERAL ${catalog}.main.geocoding(inputs.query, count := 1, country_code := 'US') AS g
), current_conditions AS (
  SELECT l.*, 'current' AS record_kind, timezone('UTC', w.time) AS time,
         timezone(l.city_timezone, w.time) AS local_time,
         w.temperature_2m AS temperature_f, w.apparent_temperature AS feels_like_f,
         w.relative_humidity_2m AS humidity_pct, w.pressure_msl AS pressure_hpa,
         w.wind_speed_10m AS wind_mph,
         ${catalog}.main.weather_code_text(w.weather_code) AS conditions
  FROM locations l,
       LATERAL ${catalog}.main.forecast_current(l.latitude, l.longitude,
         timezone := 'auto', temperature_unit := 'fahrenheit',
         wind_speed_unit := 'mph', precipitation_unit := 'inch') AS w
), daily AS (
  SELECT l.*, 'daily' AS record_kind,
         CAST(timezone(l.city_timezone, d.time) AS DATE) AS day,
         d.temperature_2m_max AS high_f, d.temperature_2m_min AS low_f,
         d.precipitation_sum AS precipitation_in, d.wind_gusts_10m_max AS gust_mph,
         ${catalog}.main.weather_code_text(d.weather_code) AS conditions
  FROM locations l,
       LATERAL ${catalog}.main.forecast_daily(l.latitude, l.longitude,
         forecast_days := 7, timezone := 'auto', temperature_unit := 'fahrenheit',
         wind_speed_unit := 'mph', precipitation_unit := 'inch') AS d
), hourly AS MATERIALIZED (
  SELECT l.*, 'hourly' AS record_kind, timezone('UTC', w.time) AS time,
         CAST(timezone(l.city_timezone, w.time) AS DATE) AS day,
         w.temperature_2m AS temperature_f, w.apparent_temperature AS feels_like_f,
         w.precipitation AS precipitation_in, w.wind_speed_10m AS wind_mph,
         w.wind_gusts_10m AS gust_mph, w.relative_humidity_2m AS humidity_pct,
         w.pressure_msl AS pressure_hpa,
         ${catalog}.main.weather_code_text(w.weather_code) AS conditions
  FROM locations l,
       LATERAL ${catalog}.main.forecast_hourly(l.latitude, l.longitude,
         forecast_days := 7, timezone := 'auto', temperature_unit := 'fahrenheit',
         wind_speed_unit := 'mph', precipitation_unit := 'inch') AS w
  WHERE w.time >= current_timestamp
), air AS MATERIALIZED (
  SELECT l.location_role, timezone('UTC', a.time) AS time,
         a.us_aqi, a.pm2_5 AS pm25_ug_m3, a.pm10 AS pm10_ug_m3,
         ${catalog}.main.us_aqi_category(a.us_aqi) AS aqi_category
  FROM locations l,
       LATERAL ${catalog}.main.air_quality_hourly(l.latitude, l.longitude,
         forecast_days := 7, timezone := 'auto') AS a
  WHERE a.time >= current_timestamp
)
SELECT * FROM daily
UNION ALL BY NAME
SELECT h.*, a.us_aqi, a.pm25_ug_m3, a.pm10_ug_m3, a.aqi_category
FROM hourly h LEFT JOIN air a USING (location_role, time)
UNION ALL BY NAME
SELECT * FROM current_conditions`;
}
