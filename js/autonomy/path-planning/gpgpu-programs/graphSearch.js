/* State Lattice Cost Map
 * 
 * 5-dimensional node: station, latitude, acceleration profile, velocity, time
 *
 * A draw call per station s
 *   * Input to kernel: latitude l, acceleration profile a, velocity range v, time range t
 *   * Find all SL vertices that can connect to this node
 *   * For each of those vertices, check if any terminate in this specific velocity and time range
 *     * Based on initial velocity, initial time, and acceleration
 *     * Each connected SL vertex should have a * v * t nodes that could possibly terminate at this node
 *   * For all valid edges, find the one with the lowest cost
 *
 * Input:
 *   * 2D texture array cost map
 *     * Height: num of latitudes (~20)
 *     * Width: num of acceleration profiles * num of time ranges * num of velocity ranges (8 * 2 * 4 = ~64)
 *       * A flattened 3D array:
 *         d1: acceleration
 *         d2: velocity
 *         d3: time
 *     * Layer: num of stations (~10)
 *   
 * Output:
 *   * 2D texture slice of the next station in the input 2D texture array cost map
 *
 * Cost Map Elements:
 *   * Traversal cost so far
 *   * Ending speed
 *   * Ending time
 *   * Index of parent node
 *
 * Since one cubic path can be shared between multiple trajectories, they need to be pre-optimized.
 *
 */

const SOLVE_STATION_KERNEL = `

const float smallV = 0.01;

float calculateAcceleration(int index, float initialVelocitySq, float distance) {
  if (index <= 4) {
    // [aMaxHard, aMinHard, aMaxSoft, aMinSoft, 0]
    return accelerationProfiles[index];
  } else {
    float finalVelocity = finalVelocityProfiles[index - 5];
    return clamp((finalVelocity * finalVelocity - initialVelocitySq) / (2.0 * distance), accelerationProfiles[1], accelerationProfiles[0]);
  }
}

int sampleCubicPath(vec4 start, vec4 end, vec4 cubicPathParams, inout vec4 samples[128], inout vec4 coefficients) {
  float p0 = start.w;
  float p1 = cubicPathParams.x;
  float p2 = cubicPathParams.y;
  float p3 = end.w;
  float sG = cubicPathParams.z;

  int numSamples = int(ceil(sG / pathSamplingStep)) + 1;

  float sG_2 = sG * sG;
  float sG_3 = sG_2 * sG;

  float a = p0;
  float b = (-5.5 * p0 + 9.0 * p1 - 4.5 * p2 + p3) / sG;
  float c = (9.0 * p0 - 22.5 * p1 + 18.0 * p2 - 4.5 * p3) / sG_2;
  float d = (-4.5 * (p0 - 3.0 * p1 + 3.0 * p2 - p3)) / sG_3;
  coefficients = vec4(a, b, c, d);

  samples[0] = start;

  float ds = sG / float(numSamples - 1);
  float s = ds;
  vec2 dxy = vec2(0);
  vec2 prevCosSin = vec2(cos(start.z), sin(start.z));

  for (int i = 1; i < numSamples; i++) {
    float rot = (((d * s / 4.0 + c / 3.0) * s + b / 2.0) * s + a) * s + start.z;
    float curv = ((d * s + c) * s + b) * s + a;

    vec2 cosSin = vec2(cos(rot), sin(rot));
    dxy = dxy * vec2(float(i - 1) / float(i)) + (cosSin + prevCosSin) / vec2(2 * i);

    samples[i] = vec4(dxy * vec2(s) + start.xy, rot, curv);

    s += ds;
    prevCosSin = cosSin;
  }

  return numSamples;
}

float staticCost(vec4 xytk) {
  vec2 xyTexCoords = (xytk.xy - xyCenterPoint) / vec2(textureSize(xyslMap, 0)) / vec2(xyGridCellSize) + 0.5;
  vec2 sl = texture(xyslMap, xyTexCoords).xy;

  vec2 slTexCoords = (sl - slCenterPoint) / vec2(textureSize(slObstacleGrid, 0)) / vec2(slGridCellSize) + 0.5;
  float obstacleCost = texture(slObstacleGrid, slTexCoords).x;

  if (obstacleCost == 1.0) return -1.0; // Infinite cost
  obstacleCost = step(0.25, obstacleCost) * obstacleHazardCost;

  float absLatitude = abs(sl.y);
  float laneCost = max(absLatitude * laneCostSlope, step(laneShoulderLatitude, absLatitude) * laneShoulderCost);

  return obstacleCost + laneCost;
}

float dynamicCost(vec4 xytk, float time, float velocity, float acceleration, float dCurv) {
  return 1.0;
}

vec4 kernel() {
  ivec2 indexes = ivec2(kernelPosition * vec2(kernelSize));

  int latitude = indexes.y;

  int numPerTime = numAccelerations * numVelocities;
  int timeIndex = indexes.x / numPerTime;
  indexes.x -= timeIndex * numPerTime;
  int velocityIndex = indexes.x / numAccelerations;
  int accelerationIndex = int(mod(float(indexes.x), float(numAccelerations)));

  int minLatitude = max(latitude - latitudeConnectivity / 2, 0);
  int maxLatitude = min(latitude + latitudeConnectivity / 2, numLatitudes - 1);

  int slIndex = station * numLatitudes + latitude;

  vec4 pathEnd = texelFetch(lattice, ivec2(latitude, station), 0);

  float minVelocity = velocityRanges[velocityIndex];
  float maxVelocity = velocityRanges[velocityIndex + 1];

  float minTime = timeRanges[timeIndex];
  float maxTime = timeRanges[timeIndex + 1];

  vec4 bestTrajectory = vec4(-1); // -1 means infinite cost
  float bestCost = 1000000000.0;

  for (int prevStation = max(station - stationConnectivity, 0); prevStation < station; prevStation++) {
    int stationConnectivityIndex = prevStation - station + stationConnectivity;

    for (int prevLatitude = minLatitude; prevLatitude <= maxLatitude; prevLatitude++) {
      int latitudeConnectivityIndex = prevLatitude - latitude + latitudeConnectivity / 2;
      int connectivityIndex = stationConnectivityIndex * latitudeConnectivity + latitudeConnectivityIndex;

      vec4 pathStart = texelFetch(lattice, ivec2(prevLatitude, prevStation), 0);
      vec4 cubicPathParams = texelFetch(cubicPaths, ivec2(slIndex, connectivityIndex), 0);

      // If cubic path didn't converge
      if (cubicPathParams.w == 0.0) continue;

      vec4 pathSamples[128];
      vec4 coefficients;
      int numSamples = sampleCubicPath(pathStart, pathEnd, cubicPathParams, pathSamples, coefficients);

      float staticCostSum = 0.0;

      for (int i = 0; i < numSamples; i++) {
        float cost = staticCost(pathSamples[i]);

        if (cost < 0.0) {
          staticCostSum = cost;
          break;
        }

        staticCostSum += cost;
      }

      if (staticCostSum < 0.0) continue;

      for (int prevVelocity = 0; prevVelocity < numVelocities; prevVelocity++) {
        for (int prevTime = 0; prevTime < numTimes; prevTime++) {
          for (int prevAccel = 0; prevAccel < numAccelerations; prevAccel++) {
            int avtIndex = prevTime * numPerTime + prevVelocity * numAccelerations + prevAccel;

            // Cost map entry:
            //   x: cost so far
            //   y: end speed
            //   z: end time
            //   w: parent index
            vec4 costTableEntry = texelFetch(costTable, ivec3(avtIndex, prevLatitude, prevStation), 0);

            // If cost entry is infinity
            if (costTableEntry.x == -1.0) continue;

            float initialVelocity = costTableEntry.y;
            float initialVelocitySq = initialVelocity * initialVelocity;
            float acceleration = calculateAcceleration(accelerationIndex, initialVelocitySq, cubicPathParams.z);

            float finalVelocitySq = 2.0 * acceleration * cubicPathParams.z + initialVelocitySq;
            float finalVelocity = max(smallV, sqrt(max(0.0, finalVelocitySq)));

            // If the calculated final velocity does not match this fragment's velocity range, then skip this trajectory
            if (finalVelocity < minVelocity || finalVelocity >= maxVelocity) continue;

            float finalTime = costTableEntry.z;

            if (acceleration == 0.0) {
              finalTime += cubicPathParams.z / finalVelocity;
            } else if (finalVelocitySq <= 0.0) { // Calculate final time if the vehicle stops before the end of the trajectory
              float distanceLeft = cubicPathParams.z - (smallV * smallV - initialVelocitySq) / (2.0 * acceleration);
              finalTime += (finalVelocity - initialVelocity) / acceleration + distanceLeft / smallV;
            } else {
              finalTime += 2.0 * cubicPathParams.z / (finalVelocity + initialVelocity);
            }

            // If the calculated final time does not match this fragment's time range, then skip this trajectory
            if (finalTime < minTime || finalTime >= maxTime) continue;

            float terminalCost = costTableEntry.x + extraTimePenalty * finalTime;
            if (terminalCost >= bestCost) continue;
            bestCost = terminalCost;

            float s = 0.0;
            float ds = cubicPathParams.z / float(numSamples - 1);
            float dynamicCostSum = 0.0;
            float maxVelocity = 0.0;
            float maxLateralAcceleration = 0.0;

            for (int i = 0; i < numSamples; i++) {
              vec4 pathSample = pathSamples[i]; // vec4(x-pos, y-pos, theta (rotation), kappa (curvature))

              float velocitySq = 2.0 * acceleration * s + initialVelocitySq;
              float velocity = max(smallV, sqrt(max(0.0, velocitySq)));
              maxVelocity = max(maxVelocity, velocity);
              maxLateralAcceleration = max(maxLateralAcceleration, abs(pathSample.w * velocity * velocity));

              float time = 2.0 * s / (initialVelocity + velocity);
              float dCurv = velocity * (coefficients.y + s * (2.0 * coefficients.z + 3.0 * coefficients.w * s));

              if (dCurv > dCurvatureMax) {
                dynamicCostSum = -1.0;
                break;
              }

              float cost = dynamicCost(pathSample, time, velocity, acceleration, dCurv);

              if (cost < 0.0) {
                dynamicCostSum = cost;
                break;
              }

              dynamicCostSum += cost;
              s += ds;
            }

            if (dynamicCostSum < 0.0) continue;

            // Apply speeding penality if any velocity along the trajectory is over the speed limit
            dynamicCostSum += step(speedLimit, maxVelocity) * speedLimitPenalty;

            // Apply hard acceleration/deceleration penalties if the acceleration/deceleration exceeds the soft limits
            dynamicCostSum += step(accelerationProfiles[2] + 0.0001, acceleration) * hardAccelerationPenalty;
            dynamicCostSum += (1.0 - step(accelerationProfiles[3], acceleration)) * hardDecelerationPenalty;

            // Penalize lateral acceleration
            dynamicCostSum += step(lateralAccelerationLimit, maxLateralAcceleration) * softLateralAccelerationPenalty;
            dynamicCostSum += linearLateralAccelerationPenalty * maxLateralAcceleration;

            // The cost of a trajectory is the average sample cost scaled by the path length
            float totalCost = (dynamicCostSum + staticCostSum) / float(numSamples) * cubicPathParams.z + costTableEntry.x;

            int incomingIndex = avtIndex + numPerTime * numTimes * (prevLatitude + numLatitudes * prevStation);
            bestTrajectory = vec4(totalCost, finalVelocity, finalTime, incomingIndex);
          }
        }
      }
    }
  }

  return bestTrajectory;
}

`;

const NUM_ACCELERATION_PROFILES = 8;
const NUM_VELOCITY_RANGES = 4;
const NUM_TIME_RANGES = 2;

export default {
  setUp() {
    return {
      kernel: SOLVE_STATION_KERNEL,
      output: { name: 'graphSearch' },
      uniforms: {
        lattice: { type: 'sharedTexture' },
        costTable: { type: 'sharedTexture', textureType: '2DArray' },
        xyslMap: { type: 'outputTexture' },
        cubicPaths: { type: 'outputTexture' },
        slObstacleGrid: { type: 'outputTexture', name: 'slObstacleGridDilated' },
        xyCenterPoint: { type: 'vec2' },
        xyGridCellSize: { type: 'float' },
        slCenterPoint: { type: 'vec2' },
        slGridCellSize: { type: 'float'},
        laneCostSlope: { type: 'float'},
        laneShoulderCost: { type: 'float'},
        laneShoulderLatitude: { type: 'float'},
        obstacleHazardCost: { type: 'float' },
        extraTimePenalty: { type: 'float' },
        speedLimit: { type: 'float' },
        speedLimitPenalty: { type: 'float' },
        hardAccelerationPenalty: { type: 'float' },
        hardDecelerationPenalty: { type: 'float' },
        lateralAccelerationLimit: { type: 'float' },
        softLateralAccelerationPenalty: { type: 'float' },
        linearLateralAccelerationPenalty: { type: 'float' },
        dCurvatureMax: { type: 'float' },
        numStations: { type: 'int' },
        numLatitudes: { type: 'int' },
        numAccelerations: { type: 'int' },
        numVelocities: { type: 'int' },
        numTimes: { type: 'int' },
        accelerationProfiles: { type: 'float', length: 5 },
        finalVelocityProfiles: { type: 'float', length: 3 },
        pathSamplingStep: { type: 'float' },
        stationConnectivity: { type: 'int' },
        latitudeConnectivity: { type: 'int' },
        station: { type: 'int' },
        velocityRanges: { type: 'float', length: NUM_VELOCITY_RANGES + 1 },
        timeRanges: { type: 'float', length: NUM_TIME_RANGES + 1 }
      },
      drawProxy: (gpgpu, program, draw) => {
        const width = NUM_ACCELERATION_PROFILES * NUM_VELOCITY_RANGES * NUM_TIME_RANGES;
        const height = program.meta.lattice.numLatitudes;
        const costTable = new Float32Array(width * height * program.meta.lattice.numStations * 4);

        for (let s = 1; s < program.meta.lattice.numStations; s++) {
          gpgpu.updateProgramUniforms(program, { station: s });
          draw();

          gpgpu.gl.readPixels(0, 0, width, height, gpgpu.gl.RGBA, gpgpu.gl.FLOAT, costTable, s * width * height * 4);

          gpgpu.gl.bindTexture(gpgpu.gl.TEXTURE_2D_ARRAY, gpgpu.sharedTextures.costTable);
          gpgpu.gl.copyTexSubImage3D(gpgpu.gl.TEXTURE_2D_ARRAY, 0, 0, 0, s, 0, 0, width, height);
        }

        gpgpu._graphSearchCostTable = costTable;
      }
    };
  },

  update(config, xyCenterPoint, slCenterPoint) {
    return {
      width: NUM_ACCELERATION_PROFILES * NUM_VELOCITY_RANGES * NUM_TIME_RANGES,
      height: config.lattice.numLatitudes,
      meta: {
        lattice: config.lattice
      },
      uniforms: {
        xyCenterPoint: [xyCenterPoint.x, xyCenterPoint.y],
        xyGridCellSize: config.xyGridCellSize,
        slCenterPoint: [slCenterPoint.x, slCenterPoint.y],
        slGridCellSize: config.slGridCellSize,
        laneCostSlope: config.laneCostSlope,
        laneShoulderCost: config.laneShoulderCost,
        laneShoulderLatitude: config.laneShoulderLatitude,
        obstacleHazardCost: config.obstacleHazardCost,
        extraTimePenalty: config.extraTimePenalty,
        speedLimit: config.speedLimit,
        speedLimitPenalty: config.speedLimitPenalty,
        hardAccelerationPenalty: config.hardAccelerationPenalty,
        hardDecelerationPenalty: config.hardDecelerationPenalty,
        lateralAccelerationLimit: config.lateralAccelerationLimit,
        softLateralAccelerationPenalty: config.softLateralAccelerationPenalty,
        linearLateralAccelerationPenalty: config.linearLateralAccelerationPenalty,
        dCurvatureMax: config.dCurvatureMax,
        numStations: config.lattice.numStations,
        numLatitudes: config.lattice.numLatitudes,
        numAccelerations: NUM_ACCELERATION_PROFILES,
        numVelocities: NUM_VELOCITY_RANGES,
        numTimes: NUM_TIME_RANGES,
        accelerationProfiles: [3.5, -6.5, 2.0, -3.0, 0],
        finalVelocityProfiles: [0.99 * config.speedLimit, 1.0, 0.01],
        pathSamplingStep: config.pathSamplingStep,
        stationConnectivity: config.lattice.stationConnectivity,
        latitudeConnectivity: config.lattice.latitudeConnectivity,
        velocityRanges: [0, config.speedLimit / 3, config.speedLimit * 2 / 3, config.speedLimit, 1000000],
        timeRanges: [0, 10, 1000000]
      }
    };
  }
}
