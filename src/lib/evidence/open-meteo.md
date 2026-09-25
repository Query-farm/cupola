# Your week outdoors

**Current conditions, the next 24 hours & your seven-day outlook**

```sql daily
SELECT *,
       strftime(day, '%Y-%m-%d') AS day_label,
       round(high_f - lag(high_f) OVER (PARTITION BY location_role ORDER BY day), 1) AS high_change_f,
       round(low_f - lag(low_f) OVER (PARTITION BY location_role ORDER BY day), 1) AS low_change_f
FROM cupola_weather WHERE record_kind = 'daily'
```

```sql primary_days
SELECT * FROM {{daily}} WHERE location_role = 'primary'
```

```sql hourly
SELECT * FROM cupola_weather WHERE record_kind = 'hourly'
```

```sql current_conditions
SELECT *, strftime(local_time, '%b %d, %H:%M') || ' · ' || city_timezone AS as_of_local
FROM cupola_weather WHERE record_kind = 'current'
```

```sql primary_current
SELECT * FROM {{current_conditions}} WHERE location_role = 'primary'
```

```sql near_forecast
SELECT * FROM {{hourly}}
QUALIFY row_number() OVER (PARTITION BY location_role ORDER BY time) <= 24
```

```sql air
SELECT * FROM {{hourly}} WHERE us_aqi IS NOT NULL
```

```sql next_air
SELECT * FROM {{air}}
QUALIFY row_number() OVER (PARTITION BY location_role ORDER BY time) = 1
```

```sql summary
SELECT city,
       concat('Expect highs from ', round(min(high_f)), ' to ', round(max(high_f)),
         ' °F and lows from ', round(min(low_f)), ' to ', round(max(low_f)), ' °F. ',
         CASE WHEN sum(precipitation_in) = 0 THEN 'No precipitation is forecast this week.'
         ELSE concat('The wettest day is ', strftime(arg_max(day, precipitation_in), '%A'),
           ', with ', round(max(precipitation_in), 2), ' inches forecast.') END) AS briefing,
       strftime(min(day), '%b %d') || ' – ' || strftime(max(day), '%b %d, %Y') AS period,
       max(city_timezone) AS city_timezone
FROM {{primary_days}} GROUP BY city
```

```sql axis_bounds
SELECT floor((min(low_f) - 3) / 5) * 5 AS min_f,
       ceil((max(high_f) + 3) / 5) * 5 AS max_f FROM {{daily}}
```

```sql wet_days
SELECT * FROM {{daily}} WHERE precipitation_in > 0
```

```sql air_coverage
SELECT city, count(*) AS forecast_hours, count(us_aqi) AS aqi_hours,
       CASE WHEN count(us_aqi) = 0 THEN 'Not available'
         ELSE strftime(min(time) FILTER (WHERE us_aqi IS NOT NULL), '%b %d %H:%M')
           || ' – ' || strftime(max(time) FILTER (WHERE us_aqi IS NOT NULL), '%b %d %H:%M') || ' UTC' END AS available_window
FROM {{hourly}} GROUP BY city
```

```sql hourly_detail
SELECT city, strftime(time, '%Y-%m-%d %H:%M') AS hour_utc,
       temperature_f, feels_like_f, humidity_pct, pressure_hpa, precipitation_in, wind_mph, us_aqi, pm25_ug_m3, conditions
FROM {{hourly}}
```

Your outlook for **{% value data="summary" value="max(city)" /%}**,
{% value data="summary" value="max(period)" /%}.
Daily forecasts follow each city's local calendar. Hourly comparisons use **UTC**.

## Right now

**{% value data="primary_current" value="max(city)" /%} · {% value data="primary_current" value="max(conditions)" /%}**\
As of {% value data="primary_current" value="max(as_of_local)" /%}.
These are the model's current conditions, separate from the upcoming hourly forecast.

{% row %}
{% big_value data="primary_current" value="max(temperature_f)" title="Temperature · °F" fmt="0.0" /%}
{% big_value data="primary_current" value="max(feels_like_f)" title="Feels like · °F" fmt="0.0" /%}
{% big_value data="primary_current" value="max(humidity_pct)" title="Relative humidity · %" fmt="0" /%}
{% big_value data="primary_current" value="max(pressure_hpa)" title="Sea-level pressure · hPa" fmt="0.0" /%}
{% /row %}

{% table data="current_conditions" title="Current conditions in both cities" order="location_role DESC" %}
{% dimension value="city" title="City" /%}
{% dimension value="as_of_local" title="As of · local time" /%}
{% dimension value="conditions" title="Conditions" /%}
{% dimension value="temperature_f" title="Temp · °F" fmt="0.0" /%}
{% dimension value="feels_like_f" title="Feels like · °F" fmt="0.0" /%}
{% dimension value="humidity_pct" title="Humidity · %" fmt="0" /%}
{% dimension value="pressure_hpa" title="Pressure · hPa" fmt="0.0" /%}
{% dimension value="wind_mph" title="Wind · mph" fmt="0" /%}
{% /table %}

## Next 24 hours

The next 24 hourly forecasts for both cities, aligned in **UTC**. Hover for hourly
values. Temperature and pressure scales follow the data; humidity uses its full
0–100% range. Pressure is adjusted to sea level so the cities are comparable.

{% line_chart data="near_forecast" x_sort="data" x="time" y="avg(temperature_f)" series="city" date_grain="hour" title="Temperature · next 24 hours" subtitle="Air temperature · °F · UTC" y_axis_options={fit_to_data=true} y_fmt="0.0" /%}
{% row %}
{% line_chart data="near_forecast" x_sort="data" x="time" y="avg(humidity_pct)" series="city" date_grain="hour" title="Humidity · next 24 hours" subtitle="Relative humidity · % · UTC" y_axis_options={min=0 max=100} y_fmt="0" /%}
{% line_chart data="near_forecast" x_sort="data" x="time" y="avg(pressure_hpa)" series="city" date_grain="hour" title="Pressure · next 24 hours" subtitle="Mean sea-level pressure · hPa · UTC" y_axis_options={fit_to_data=true} y_fmt="0.0" /%}
{% /row %}

## The week ahead

{% callout type="info" title="Weekly summary" %}
{% value data="summary" value="max(briefing)" /%}
{% /callout %}

{% row %}
{% big_value data="primary_days" value="max(high_f)" title="Week’s high · °F" fmt="0" sparkline={x="day" type="line" date_grain="day" fit_to_data=true} /%}
{% big_value data="primary_days" value="min(low_f)" title="Week’s low · °F" fmt="0" /%}
{% big_value data="primary_days" value="sum(precipitation_in)" title="Week’s precipitation · in" fmt="0.00" /%}
{% big_value data="next_air" where="location_role = 'primary'" value="max(us_aqi)" title="Next forecast hour · US AQI" fmt="0" /%}
{% /row %}

## Day by day

Click a city header to collapse its week. **▲ warmer / ▼ cooler** compares each high
or low with the previous forecast day in that city; **—** means no prior day or no
change. Changes are in °F. Today is a **full-day forecast**, including hours already
elapsed, rather than just the rest of today.

{% table data="daily" title="Daily outlook" order="city, day_label" subtotals=true collapsible=true collapsed=false show_total_row=false total_label="Seven-day summary" %}
{% dimension value="city" title="City" /%}
{% dimension value="day_label" title="Local date" /%}
{% measure value="max(high_f)" title="High · °F" fmt="0.0" /%}
{% measure value="max(high_change_f)" title="Δ high" fmt="0.0" viz="delta" delta_options={symbol_position="left"} hide_row_totals=true /%}
{% measure value="min(low_f)" title="Low · °F" fmt="0.0" /%}
{% measure value="max(low_change_f)" title="Δ low" fmt="0.0" viz="delta" delta_options={symbol_position="left"} hide_row_totals=true /%}
{% measure value="sum(precipitation_in)" title="Precip. · in" fmt="0.00" viz="bar" /%}
{% measure value="max(gust_mph)" title="Gust · mph" fmt="0" /%}
{% /table %}

## Compare the week

Both charts use the **same temperature scale**. The comparison is by local calendar
date; each city's high and low can occur at different times.

{% repeat id="axis_min" data="axis_bounds" column="min_f" %}
{% repeat id="axis_max" data="axis_bounds" column="max_f" %}
{% row %}
{% line_chart data="daily" x="day" y="max(high_f)" series="city" date_grain="day" title="Daytime highs" subtitle="Daily maximum · °F" y_axis_options={min="{{axis_min.literal}}" max="{{axis_max.literal}}" fit_to_data=true} y_fmt="0" /%}
{% line_chart data="daily" x="day" y="min(low_f)" series="city" date_grain="day" title="Overnight lows" subtitle="Daily minimum · °F" y_axis_options={min="{{axis_min.literal}}" max="{{axis_max.literal}}" fit_to_data=true} y_fmt="0" /%}
{% /row %}
{% /repeat %}
{% /repeat %}

{% if data="wet_days" %}
{% bar_chart data="daily" x="day" y="sum(precipitation_in)" series="city" date_grain="day" title="Plan around the rain" subtitle="Full local-day precipitation · inches, not probability" y_fmt="0.00" /%}
{% /if %}
{% else %}
{% callout type="info" title="A dry week in both cities" %}
No precipitation is forecast in either city during these seven days.
{% /callout %}
{% /else %}

## Air quality: a different forecast window

Air quality is a model forecast, not a local sensor reading. Its available window
can be shorter than the weather forecast. Missing hours stay blank and are excluded
from AQI calculations.

{% if data="air" %}
{% table data="next_air" title="Next available forecast hour" order="city" %}
{% dimension value="city" title="City" /%}
{% dimension value="strftime(time, '%Y-%m-%d %H:%M')" title="Forecast hour · UTC" /%}
{% dimension value="us_aqi" title="US AQI" fmt="0" /%}
{% dimension value="aqi_category" title="Category" /%}
{% dimension value="pm25_ug_m3" title="PM2.5 · µg/m³" fmt="0.0" /%}
{% /table %}

{% line_chart data="air" x="time" y="max(us_aqi)" series="city" date_grain="hour" title="How air quality changes" subtitle="US AQI · lower values mean less pollution · UTC" y_fmt="0" %}
{% reference_line y=50 label="Good / Moderate boundary" /%}
{% reference_line y=100 label="Moderate / sensitive-groups boundary" /%}
{% /line_chart %}

{% details title="Pollutants and forecast coverage" %}
{% line_chart data="air" x="time" y="avg(pm25_ug_m3)" series="city" date_grain="hour" title="Fine particles · PM2.5" subtitle="Forecast concentration · µg/m³ · UTC" y_fmt="0.0" /%}
{% progress_bars data="air_coverage" dimension="city" numerator="sum(aqi_hours)" denominator="sum(forecast_hours)" title="Hours with AQI data" /%}
{% table data="air_coverage" %}
{% dimension value="city" title="City" /%}
{% dimension value="available_window" title="Available AQI forecast" /%}
{% dimension value="aqi_hours" title="AQI hours" fmt="0" /%}
{% dimension value="forecast_hours" title="Weather hours" fmt="0" /%}
{% /table %}
{% /details %}
{% /if %}
{% else %}
{% callout type="info" title="Air-quality data unavailable" %}
No AQI values were returned for these cities. The weather outlook remains available.
{% /callout %}
{% /else %}

## Explore the hourly detail

{% tabs %}
{% tab title="Temperature & wind" %}
{% line_chart data="hourly" x="time" y="avg(temperature_f)" series="city" date_grain="hour" title="Temperature through the week" subtitle="Upcoming forecast hours · °F · UTC" y_axis_options={fit_to_data=true} y_fmt="0" /%}
{% area_chart data="hourly" where="location_role = 'primary'" x="time" y="avg(wind_mph)" date_grain="hour" title="Wind through the week" subtitle="Primary city · sustained wind speed · mph · UTC" y_fmt="0" /%}
{% /tab %}
{% tab title="Hourly data" %}
{% table data="hourly_detail" page_size=12 order="hour_utc, city" %}
{% dimension value="city" title="City" /%}
{% dimension value="hour_utc" title="Hour · UTC" /%}
{% dimension value="temperature_f" title="°F" fmt="0.0" /%}
{% dimension value="feels_like_f" title="Feels like · °F" fmt="0.0" /%}
{% dimension value="humidity_pct" title="Humidity · %" fmt="0" /%}
{% dimension value="pressure_hpa" title="Pressure · hPa" fmt="0.0" /%}
{% dimension value="precipitation_in" title="Precip. · in" fmt="0.00" /%}
{% dimension value="us_aqi" title="US AQI" fmt="0" /%}
{% dimension value="conditions" title="Conditions" /%}
{% /table %}
{% /tab %}
{% /tabs %}

{% details title="Sources, timing and definitions" %}

**Current conditions:** the connector’s current-weather endpoint, with its own
model timestamp shown in each city’s timezone. These are not station observations.
Humidity is relative humidity; pressure is mean sea-level pressure in hPa. The
near forecast uses the next 24 available hourly samples from the same refresh.

**Daily forecast:** today plus the following six local dates. Daily highs, lows,
precipitation totals and maximum gusts come from the daily forecast endpoint.
City headers summarize the seven days; temperature changes have no weekly subtotal.
The first day's change is blank because no previous day is included.

**Hourly forecast:** upcoming hours only, displayed in UTC to compare the same
instants across cities. The primary city's timezone is
{% value data="summary" value="max(city_timezone)" /%}.

**Air quality:** US AQI categories come from the connector. PM2.5 measures fine
particles; it is a concentration, not an AQI score. Coverage refers to hours with
a non-null US AQI value. Refreshing retrieves the latest available service data;
the service may use cached upstream forecasts.

**Sources:** [Open-Meteo weather](https://open-meteo.com/) and
[Open-Meteo / CAMS air-quality forecasts](https://open-meteo.com/en/docs/air-quality-api),
accessed through the [Query.Farm VGI service](https://query.farm/vgi/).
Saving stores this report and its inputs, not a frozen forecast.

{% /details %}
