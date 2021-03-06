/*jshint esversion: 6 */

// Copyright 2017 Intel Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const INTERPOLATE_INV = 1 / 20.0; // interpolate depth physics at 20 pixels.

class DepthAndSegments {
  constructor(gl, drawGL = null) {
    this.gl = gl;
    gl.depth_tex_unit = gl.depth_tex_unit | gl.TEXTURE0;
    initGL(gl, drawGL);
    reload();
    // this.createDepthInfoCanvas();
    this.out = {};
    this.out1 = {};
    this.out.segment_data = {};
    this.out1.segment_data = {};
    this.transform_feedback_draw_done = false;
    this.gbsd_async_ready = false;
    this.width = 640;
    this.height = 480;
  }

  // In case when we use one WebGL context for processing (WebGL 2.0) and 
  // another |drawGL| for rendering depth, we upload depth texture to both.
  // 
  process(drawGL) {
    if (!video_loaded)
      return false;
    if (!init_done) {
      this.videoLoaded(video, window.stream);
      init_done = true;
    }
    const gl = this.gl; 
    if (this.transform_feedback_draw_done) {
      // This is used only when WEBGL_get_buffer_sub_data_async extension is not
      // available. 
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, gl.tf_bo);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, tf_output, 0, tf_output.length);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
      processOnCPU();
      this.identifyJointsAndFixNoise(out.segment_data);

      this.out1 = this.out;
      this.out = out;

      putReadPixelsToTestCanvas(this.testContext);
      this.transform_feedback_draw_done = false;
      return true;
    }
    let processed = false;
    if (this.gbsd_async_ready) {
      // gbsd = getBufferSubData. Process the results from the previous frame
      // make asynchronous request for this frame data below. 
      this.gbsd_async_ready = false;
      processOnCPU();
      this.identifyJointsAndFixNoise(out.segment_data);

      this.out1 = this.out;
      this.out = out;

      putReadPixelsToTestCanvas(this.testContext);   
      processed = true;
    }

    if (video_last_upload_time == video.currentTime) {
      return processed;
    }
    video_last_upload_time = video.currentTime;
    gl.activeTexture(gl.depth_tex_unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.depth_texture);

    // Upload the video frame to texture.
    if (gl.color_buffer_float_ext) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, gl.RED, gl.FLOAT, video);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, gl.RGBA, gl.FLOAT, video);
    }
    
    if (drawGL && drawGL != gl) {
      drawGL.activeTexture(gl.depth_tex_unit);
      drawGL.bindTexture(gl.TEXTURE_2D, drawGL.depth_texture);
      drawGL.texImage2D(drawGL.TEXTURE_2D, 0, drawGL.RGBA, drawGL.RGBA, drawGL.FLOAT, video);     
    }

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.useProgram(gl.compute_program);
    gl.bindVertexArray(gl.depth_vao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, gl.transform_feedback)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, gl.tf_bo)
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, tf_output.length);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindVertexArray(null);

    gl.disable(gl.RASTERIZER_DISCARD);
    this.transform_feedback_draw_done = !gl.WEBGL_get_buffer_sub_data_async;

    if (gl.WEBGL_get_buffer_sub_data_async) {
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, gl.tf_bo);
      this.gbsd_async_ready = false;
      const this_ = this;

      gl.WEBGL_get_buffer_sub_data_async.getBufferSubDataAsync(
          gl.TRANSFORM_FEEDBACK_BUFFER, 0, tf_output, 0, tf_output.length).
          then(function(buffer) {
            this_.gbsd_async_ready = true;
          });
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    }
    return processed;
  }

  getMVPMatrix() {
    return getMvpMatrix(window.innerWidth, window.innerHeight);
  }

  draw(mvp = null, lightmvp, light_position, shadow_map_unit) {
    const gl = this.gl;
    if (!video_loaded)
      return;

    gl.useProgram(gl.render_program);
    
    gl.uniformMatrix4fv(gl.render_u_mvp, false, mvp || this.getMVPMatrix());
    const point_size = ((window.innerHeight / height) | 0) + 1;
    gl.uniform1f(gl.render_u_pointSize, point_size);
    if (lightmvp) {
      gl.uniformMatrix4fv(gl.u_mvp_from_light, false, lightmvp);
      gl.uniform1f(gl.u_draw_lighting, 1.0);
      gl.uniform1i(gl.render_u_shadow_map, shadow_map_unit);
    } else {
      // TODO: separate program for shadow rendering.
      gl.uniform1f(gl.u_draw_lighting, 0);
      // shadow map texture is bound to framebuffer. prevent loop as we use the
      // same program for lighting and read from the same texture. 
      gl.uniform1i(gl.render_u_shadow_map, shadow_map_unit + 1);
    }

    if (light_position)
      gl.uniform3fv(gl.render_u_light_position, light_position);

    gl.bindVertexArray(gl.depth_vao);
    gl.activeTexture(gl.depth_tex_unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.depth_texture);
    gl.drawArrays(gl.POINTS, 0, width * height);
    gl.bindVertexArray(null);
  }

  createDepthInfoCanvas() {
    var canvas = document.createElement('canvas');
    canvas.id = "testCanvas2D";
    canvas.width = 640;
    canvas.height = 480;
    canvas.style.zIndex = 8;
    canvas.style.position = "absolute";
    canvas.style.border = "1px solid";
    var body = document.getElementsByTagName("body")[0];
    body.appendChild(canvas);
    this.testContext = canvas.getContext("2d");
  }

  videoLoaded(video, stream) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.tf_bo);
    tf_output = new Float32Array(video.videoWidth * video.videoHeight);
    gl.bufferData(gl.ARRAY_BUFFER, tf_output.length * 4, gl.DYNAMIC_READ);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    links = new Array(video.videoWidth * video.videoHeight).fill(-1);

    width = video.videoWidth;
    height = video.videoHeight;
    this.width = width;
    this.height = height;
    try {
      this.setCameraParameters(DepthCamera.getCameraCalibration(stream));
    } catch(e) {
      return handleError(e);
    }
    if (this.depthVideoLoadedCallback)
      this.depthVideoLoadedCallback();
  }

  setCameraParameters(parameters) {
    const gl = this.gl;    
    const nearplane = 0.0;
    const farplane = 0.75 / parameters.depthScale;
    const program = gl.render_program;
    gl.useProgram(program);
    let shaderVar = gl.getUniformLocation(program, "u_depth_scale");
    gl.uniform1f(shaderVar, parameters.depthScale);
    const depthIntrinsics = parameters.getDepthIntrinsics(width, height);
    shaderVar = gl.getUniformLocation(program, "u_depth_focal_length_inv");
    const inv_focal_length = [1 / depthIntrinsics.focalLength[0], 1 / depthIntrinsics.focalLength[1]];
    gl.uniform2fv(shaderVar, inv_focal_length);
    shaderVar = gl.getUniformLocation(program, "u_depth_offset");
    gl.uniform2fv(shaderVar, depthIntrinsics.offset);
    gl.uniform2f(gl.getUniformLocation(program, "u_depth_texture_size"), width, height);
    var shaderDepthTexture = gl.getUniformLocation(program, "u_depth_texture");
    gl.uniform1i(shaderDepthTexture, gl.depth_tex_unit - gl.TEXTURE0);

    this.depth_focal_inv = [1 / depthIntrinsics.focalLength[0],
                            1 / depthIntrinsics.focalLength[1]];
    this.depth_offset = depthIntrinsics.offset;
    this.depth_scale = parameters.depthScale;

    gl.useProgram(gl.compute_program);
    gl.uniform2f(gl.getUniformLocation(gl.compute_program, "u_plane"), nearplane, farplane);
    gl.uniform2f(gl.getUniformLocation(gl.compute_program, "u_depth_size"), width, height);

    
    // Coefficient is used to calculate the width of finger (in pixels) on given
    // distance (depth) from camera. Assume that finger is wider than 0.6 cm.
    const finger_half_width = 0.0027 * depthIntrinsics.focalLength[0] / parameters.depthScale;
    gl.uniform1f(gl.getUniformLocation(gl.compute_program, "finger_half_width"), finger_half_width);
    // 5 cm for longest finger segment. Fingers usually have 2-3 of those.
    segment_coef = 0.05 * depthIntrinsics.focalLength[0] / parameters.depthScale;
    this.depth_coef = this.depth_scale * this.depth_focal_inv[0]; // cache the computed
  }

  setXZFlip(value) {
    const gl = this.gl; 
    gl.useProgram(gl.render_program);
    gl.uniform1f(gl.render_u_xz_flip, value ? 0.0 : 1.0);
    gl.useProgram(gl.compute_program);
    gl.uniform1f(gl.compute_u_xz_flip, value ? 0.0 : 1.0);
  }

  identifyJointsAndFixNoise(segment_data) {
    // in segment data, identify end points that are joints.
    let keys = Object.keys(segment_data);

    function square(p) { return p * p; }
    function pointsNear(p, seg1, coef, scale) {
      const distance = square(coef * (seg1.x - p.x)) + square(coef * (seg1.y - p.y))
                     + square(scale * (seg1.depth - p.depth));
      return distance < 0.0009;                
    }

    for (let k = 0; k < keys.length; k++) {
      const seg0 = segment_data[keys[k]];
      const fl = seg0.far_left;
      const fr = seg0.far_right;
      for (let l = k + 1; l < keys.length; l++) {
        const seg1 = segment_data[keys[l]];
        // rough/fast estimation on arbitrary threshold.
        const coef = seg1.depth * this.depth_coef;
        const scale = this.depth_scale;
        if (pointsNear(fl, seg1, coef, scale)) {
          fl.joint = seg1.index;
          seg1.joint = fl.index;
        }
        if (pointsNear(fr, seg1, coef, scale)) {
          fr.joint = seg1.index;
          seg1.joint = fr.index;
        }
      }
      // check the special cases: vertical and horizontal orientation.
      const maxy = Math.max(fr.y, fl.y);
      if (fr.x - fl.x < 0.3 * (maxy - seg0.y)) {
        // vertical thing, use the furthest one.
        const in_the_middle = (fr.y < fl.y) ? fr : fl;
        in_the_middle.joint = in_the_middle.index;
      } else {
        const ignore = seg0.count_right < seg0.count_left ? fr : fl;
        ignore.joint = ignore.index;
      }
    }

    // For endpoints that are not joints, we average using center points where
    // available.
    function useCenterIfAvailable(p) {
      if (p.center.x == -1)
        return;
      p.x_original = p.x;
      p.y_original = p.y;
      p.x = p.center.x;
      p.y = p.center.y;
      p.index = p.x + p.y * width;
      p.depth = modf(tf_output[p.index]);
    }

    function moveAwayFromEdge(p, to) {
      // Limit the movement to 5mm.
      const pixels = segment_coef_5mm / p.depth;
      let xstep = 1;
      let ystep = 1;
      let steps = pixels;
      const xdiff = Math.abs(p.x - to.x);
      const ydiff = Math.abs(p.y - to.y);
      if (xdiff < 2 && ydiff < 2)
        return;
      const hypotenuse = Math.sqrt(xdiff * xdiff + ydiff * ydiff);
      if (xdiff > ydiff) {
        xstep = Math.sign(p.x - to.x);
        ystep = (p.y - to.y) / hypotenuse;
        steps = pixels * xdiff / hypotenuse;
      } else {
        ystep = Math.sign(p.y - to.y);
        xstep = (p.x - to.x) / hypotenuse;
        steps = pixels * ydiff / hypotenuse;
      }
      let hitedge = false;
      let x = p.x + 0.5;
      let y = p.y + 0.5;
      let i = 1;
      while (i < steps) {
        x += xstep;
        y += ystep;
        if (tf_output[(y | 0) * width + (x | 0)] == 0) {
          break;
        }
        i++;
      }
      if (i >= steps)
        return;
      x = p.x - xstep * (steps - i);
      y = p.y - ystep * (steps - i);
      p.x = (x + 0.5) | 0;
      p.y = (y + 0.5) | 0;
    }

    const segment_coef_5mm = segment_coef * 0.12;
    for (let k = 0; k < keys.length; k++) {
      const seg0 = segment_data[keys[k]];
      if (!seg0.far_left.hasOwnProperty("joint"))
        useCenterIfAvailable(seg0.far_left);
      if (!seg0.far_right.hasOwnProperty("joint"))
        useCenterIfAvailable(seg0.far_right);
      // Move ends away from the edge.
      const end = seg0.far_left.hasOwnProperty("joint") ? seg0.far_right : seg0.far_left;
      if (!end.hasOwnProperty("joint"))
        moveAwayFromEdge(end, seg0);
      if (!seg0.hasOwnProperty("joint"))
        moveAwayFromEdge(seg0, end);
    }
  }

  // Non skeleton means that client knows the depth value is not on skeleton and
  // here we know it is encoded as negative. Saves one abs - premature optimization :)
  getDepthNonSkeleton(x, y) {
    return modf(-tf_output[y * width + x]);
  }

  getSegmentInterpolatedCount(segment) {
    const end = this.getSegmentEnd(segment);
    return (end.distance2D * INTERPOLATE_INV) | 0;  
  }

  // vec is float[3]: x, y in pixels define the screen point and depth is the captured
  // value at the point.
  getInterpolatedPoint(vec, segment, i) {
    const end = this.getSegmentEnd(segment);
    const coef = (i + 1) / (end.distance2D * INTERPOLATE_INV);
    vec[0] = (segment.x + coef * (end.x - segment.x)) | 0;
    vec[1] = (segment.y + coef * (end.y - segment.y)) | 0;
    vec[2] = segment.depth + coef * (end.depth - segment.depth);
  }

  getSegmentEnd(seg) {
    // TODO: move this to identifyJoints if used always.
    let end = (seg.count_left > seg.count_right) ? seg.far_left : seg.far_right;
    const jl = seg.far_left.hasOwnProperty("joint");
    const jr = seg.far_right.hasOwnProperty("joint");
    if (jl && !jr)
      end = seg.far_right;
    else if (jr && !jl)
      end = seg.far_left;
    if (!end.distance2D) {
      const x = end.x - seg.x;
      const y = end.y - seg.y;
      end.distance2D = Math.sqrt(x * x + y * y);
    }
    return end;
  }
}

var video_loaded = false;

function handleError(error) {
  if (error.name == 'TrackStartError' || error.name == 'UnsupportedSizeError') {
    return reload();
  }
  if (error.name == "OverconstrainedError" && error.constraint == "videoKind")
    return console.error("No device with \"videoKind == depth\" capture available.");
  console.error(error);
}

// Offscreen |video| we use to upload depth content to WebGL texture.
let init_done = false;
let video_last_upload_time = -1;
let video = createDepthVideo();

function createDepthVideo() {
  var video = document.createElement("video");
  video.autoplay = true;
  video.loop = true;
  video.crossOrigin = "anonymous";
  video.width = 640;
  video.height = 480;
  video.oncanplay = function(){
    video_loaded=true;
    init_done = false;
  };  
  return video;
}

function reload() {
  if (window.stream) {
    window.stream.getTracks().forEach(function(track) {
      track.stop();
    });
  }

  function streamOpened(stream) {
    video.srcObject = stream;
    window.stream = stream;
    video_loaded = false;
    init_done = false;
    retrycount = 2;
  };

  DepthCamera.getDepthStream().then(streamOpened).catch(handleError);
}

function putReadPixelsToTestCanvas(testContext) {
  if (testContext == undefined)
    return;
  const img = testContext.getImageData(0, 0, video.width, video.height);
  const data = img.data;
  const segment_data = out.segment_data;

  for (let i = 0, j = 0; i < data.length; i += 4) {
    let val = tf_output[i / 4];
    let depth = val > 0.0 ? 110 : (modf(-val) * 1200);
    if (val < 0 && links[i / 4] != -1)
      depth = 60; // visited points.
    data[i] = depth;
    data[i + 1] = depth;
    data[i + 1] = depth;
    if (val > -1)
      data[i + 2] = depth;
    else
      data[i + 2] = 0;
    data[i+3] = 255;
  }

  testContext.putImageData(img, 0, 0);

  // draw the connected segments
  testContext.strokeStyle="#00FF00";
  let keys = Object.keys(segment_data);
  for (let k = 0; k < keys.length; k++) {
    const keystring = keys[k];
    const segment = segment_data[keystring];
    const index = parseInt(keystring);

    let strokeStyle = "#00FF00";
    if (segment.hasOwnProperty("discarded"))
      strokeStyle="#FF0000";

    const column = index % width;
    const row = Math.floor(index / width);
    if (column !== segment.x && row !== segment.y)
      console.log("error column/row wrong");

    let item = segment.far_left;
    if (item.index !== undefined) {
      if (item.hasOwnProperty("joint"))
        testContext.strokeStyle = "#AAAA00";
      else
        testContext.strokeStyle = strokeStyle;
      testContext.beginPath();
      testContext.fillStyle="#FFFF00";
      testContext.fillRect(column, row, 2, 2);
      if (item.hasOwnProperty("x_original")) {
        testContext.fillStyle="#007F7F";
        testContext.fillRect(item.x_original, item.y_original, 2, 2);
        testContext.fillStyle="#FFFFFF";        
      } else {
        testContext.fillStyle="#0000FF";
      }
      testContext.fillRect(item.x, item.y, 2, 2);
      testContext.moveTo(column, row);
      testContext.lineTo(item.x, item.y);
      testContext.stroke();      
    }

    item = segment.far_right;
    if (item.index !== undefined) {
      if (item.hasOwnProperty("joint"))
        testContext.strokeStyle="#AAAA00";
      else
        testContext.strokeStyle = strokeStyle;
      testContext.beginPath();
      testContext.moveTo(column, row);
      testContext.lineTo(item.x, item.y);
      if (item.hasOwnProperty("x_original")) {
        testContext.fillStyle="#7F7F00";
        testContext.fillRect(item.x_original, item.y_original, 2, 2);
        testContext.fillStyle="#FFFFFF";        
      } else {
        testContext.fillStyle="#FF0000";        
      }
      testContext.fillRect(item.x, item.y, 2, 2);

      testContext.stroke();      
    }

    // Draw joints
    
//    testContext.fillStyle="#FF0000";
//    testContext.fillRect(column, row, 2, 2);
//    testContext.stroke();
  }
  const img1 = testContext.getImageData(0, 0, video.width, video.height);
  testContext.putImageData(img1, 0, 0);

}

// Creates WebGL/WebGL2 context used to upload depth video to texture.
function initGL(gl, drawGL) {
  // EXT_color_buffer_float to use single component R32F texture format.
  gl.color_buffer_float_ext = gl.getExtension('EXT_color_buffer_float');
  gl.WEBGL_get_buffer_sub_data_async = gl.getExtension("WEBGL_get_buffer_sub_data_async");
  if (drawGL) {
    drawGL.color_buffer_float_ext = drawGL.getExtension('EXT_color_buffer_float') ||
                                    drawGL.getExtension('OES_texture_float');
  }

  if (!gl || !gl.color_buffer_float_ext) {
    alert("The depth capture demo doesn't run because it requires WebGL2 support with EXT_color_buffer_float.");
    return;
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Transform feedback vertex shader is used for detecting "finger skeleton"
  // candidate points. Passes the result as "out depth": if depth is > 1.0 then
  // the CPU side of algorithm collects nearby skeleton points to segments.  
  var tf_vertex_shader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(tf_vertex_shader, `#version 300 es
    uniform sampler2D s_depth;
    uniform vec2 u_depth_size;
    uniform vec2 u_plane;
    uniform float finger_half_width;
    uniform float xz_flip;
    out float depth;

    void main() {
      vec2 depth_pixel;
      depth_pixel.x = mod(float(gl_VertexID), u_depth_size.x) + 0.5;
      depth_pixel.y = clamp(floor(float(gl_VertexID) / u_depth_size.x),
                            0.0, u_depth_size.y) + 0.5;
      vec2 tex_pos = depth_pixel / u_depth_size;

      // If camera faces towards user, mirror the display.
      if (xz_flip != 0.0)
        tex_pos.x = 1.0 - tex_pos.x;

      depth = texture(s_depth, tex_pos).r;
      if (depth <= u_plane.x || depth >= u_plane.y) {
      	depth = 0.0;
        return;
      }

      vec2 step = vec2(1.0, 1.0) / u_depth_size;

      float d_0;
      float d_90;
      float d_180;
      float d_270;

      // Calculate max_width of the finger at the given distance. Asuming that finger is
      // wider than ~0.6cm, min_width_half is width (in pixels) related to 0.3 cm.
      float min_width_half = finger_half_width / depth;
      float max_width_half = min_width_half * 6.0;

      // Sample around and increase the distance of samples to the point.
      // The idea is that on distance D all the samples are inside the area
      // but on the distance D + 3, 3 or 4 out of 4 are outside the area. This
      // would make the point "fingertip point" (e.g part of the skeleton) for
      // the area.
      float width_step = min_width_half * 0.8;
      float inside_count = 4.0;

      float k = 0.0; 
      float s_y = 1.0;
      float s_x = 1.0;
      float i = max(min_width_half * 0.19, 1.0); // 0.19 + 0.8 = 0.99, check k.

      for (; i < max_width_half; i += width_step, k++) {
        d_0   =  texture(s_depth, tex_pos + vec2( i, 0.0) * step).r;
        d_90  =  texture(s_depth, tex_pos - vec2( 0.0, i) * step).r;
        d_180 =  texture(s_depth, tex_pos - vec2( i, 0.0) * step).r;
        d_270 =  texture(s_depth, tex_pos + vec2( 0.0, i) * step).r;
        if (d_0 * d_90 * d_180 * d_270 == 0.0) {
          s_x = sign(d_0) + sign(d_180);
          s_y = sign(d_90) + sign(d_270);                    
          inside_count = s_x + s_y;
          break;
        }
      }

      // k > 2.0 serves to eliminate "thin" areas. We pass depth > 0 through
      // transform feedback, so that CPU side of algorithm would understands
      // that this point is "part of finger bone" point and process it further.
      if (k > 2.0 && inside_count <= 1.0) {
        depth = depth + k;
        return;
      } else if (k > 2.0 && inside_count == 2.0 && (s_x * s_y == 0.0))
        return;

      // We also need large areas info as they are modeled using circles - as a
      // net of pearls.
      depth = -depth;
      if (inside_count > 3.0)
        depth -= 1.0;
    }`
  );
  gl.compileShader(tf_vertex_shader);

  var tf_dummy_pixel_shader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(tf_dummy_pixel_shader, `#version 300 es
  	precision mediump float;
    in float depth;
    void main() {
    }`
  );
  gl.compileShader(tf_dummy_pixel_shader);

  var compute_program = gl.createProgram();
  gl.attachShader(compute_program, tf_vertex_shader);
  gl.attachShader(compute_program, tf_dummy_pixel_shader);
  gl.transformFeedbackVaryings(compute_program, ["depth"], gl.SEPARATE_ATTRIBS);
  gl.linkProgram(compute_program);
  console.log(gl.getShaderInfoLog(tf_vertex_shader));
  gl.useProgram(compute_program);
  gl.depth_vao = gl.createVertexArray();
  gl.bindVertexArray(gl.depth_vao);
  // To restore state of vertex attrib arrays
  const vattrib_count = Math.min(32, gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
  for (let i = 0; i < vattrib_count; i++)
    gl.disableVertexAttribArray(i); 
  gl.bindVertexArray(null);
  var tf_bo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tf_bo);
  var transform_feedback = gl.createTransformFeedback();
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transform_feedback)

  gl.uniform1i(gl.getUniformLocation(compute_program, "s_depth"), gl.depth_tex_unit - gl.TEXTURE0);
  gl.compute_u_xz_flip = gl.getUniformLocation(compute_program, "xz_flip");
  gl.uniform1i(gl.compute_u_xz_flip, 0);

  // 3D Pointcloud rendering.
  var vertex_shader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertex_shader, `#version 300 es
    precision mediump float;
    // Run a vertex shader instance for each depth data point to create
    // 3D model of the data (pointcloud).

    ////////////////////////////////////////////////////////////////////
    // Parameters of the currently used camera, see
    // https://github.com/IntelRealSense/librealsense/blob/master/doc/projection.md
    // and the documentation at
    // https://w3c.github.io/mediacapture-depth/#synchronizing-depth-and-color-video-rendering


    // Used to convert the raw depth data into meters.
    // Corresponds to rs_get_device_depth_scale() in librealsense.
    uniform float u_depth_scale;
    // Center of projection of the depth camera data.
    uniform vec2 u_depth_offset;
    // Focal length of the depth data.
    uniform vec2 u_depth_focal_length_inv;
    ////////////////////////////////////////////////////////////////////

    // Model-View-Projection matrix.
    uniform mat4 u_mvp;
    uniform mat4 u_mvp_from_light;

    uniform float u_draw_lighting;
    uniform float u_pointSize;
    uniform float xz_flip;

    uniform sampler2D u_depth_texture;

    // Width and height of the depth data.
    uniform vec2 u_depth_texture_size;
    out vec3 v_normal;
    out vec3 v_position;
    out vec4 v_position_from_light;

    // Convert the index of the depth data (ranged from [0, 0] to
    // [u_depth_texture_size.x, u_depth_texture_size.y]) into a position
    // in 3D space. The depth parameter needs to be in meters.
    // This should be equivalent to what rs_deproject_pixel_to_point()
    // in librealsense does.
    vec4 depth_deproject(vec2 index, float depth) {
        vec2 position2d = (index - u_depth_offset) * u_depth_focal_length_inv;
        return vec4(position2d * depth, depth, 1.0);
    }

    void main() {
        // Get the texture coordinates in range from [0, 0] to [1, 1]
        vec2 depth_pixel;
        depth_pixel.x = mod(float(gl_VertexID), u_depth_texture_size.x) + 0.5;
        depth_pixel.y = clamp(floor(float(gl_VertexID) / u_depth_texture_size.x),
                              0.0, u_depth_texture_size.y) + 0.5;
        vec2 depth_texture_coord = depth_pixel / u_depth_texture_size;
        if (xz_flip != 0.0)
          depth_texture_coord.x = 1.0 - depth_texture_coord.x;
        // The values of R, G and B should be equal, so we can just
        // select any of them.
        float depth = texture(u_depth_texture,
                              depth_texture_coord).r;
        if (depth == 0.0)
          return;

        // For example, a value of 1.5 means the current point is 1.5
        // meters away.
        float depth_scaled = u_depth_scale * depth;
        // X and Y are the position within the depth texture (adjusted
        // so that it matches the position of the RGB texture), Z is
        // the depth.
        vec4 position = depth_deproject(depth_pixel,
                                        depth_scaled);
        if (u_draw_lighting != 0.0) {
          // Calculate normal based on surrounding pixels.
          vec2 stepx = vec2(1.0, 0.0) / u_depth_texture_size;
          vec2 stepy = vec2(0.0, 1.0) / u_depth_texture_size;
          float d_0 = texture(u_depth_texture, depth_texture_coord + stepx).r;
          float d_90 = texture(u_depth_texture, depth_texture_coord + stepy).r;
          float d_180 = texture(u_depth_texture, depth_texture_coord - stepx).r;
          float d_270 = texture(u_depth_texture, depth_texture_coord - stepy).r;

          // Edges are tricky, for 0 depth pixels on edges, don't render.
          // if (d_0 * d_90 * d_180 * d_270 == 0.0)
          //   return;
          float ddx = (d_0 - d_180) * 0.5;
          float ddy = (d_90 - d_270) * 0.5;
          v_normal = vec3(ddx, ddy, depth * u_depth_focal_length_inv.x);
          v_position_from_light = u_mvp_from_light * position;
        }

        v_position = vec3(position);
        gl_Position = u_mvp * position;
        gl_PointSize = u_pointSize;
    }`
  );
  gl.compileShader(vertex_shader);

  var pixel_shader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(pixel_shader, `#version 300 es
  	precision mediump float;
    precision highp sampler2DShadow;
    uniform sampler2DShadow u_shadow_map;

    uniform float u_draw_lighting;
    uniform vec3 u_light_position;

    in vec3 v_normal;
    in vec3 v_position;
    in vec4 v_position_from_light;
    out vec4 fragColor;
    void main() {
      if (u_draw_lighting != 1.0)
        return;
      vec3 s = (v_position_from_light.xyz / v_position_from_light.w) * 0.5 + 0.49;
      float shadow = texture(u_shadow_map, s);
      vec3 normal = normalize(v_normal);
      vec3 to_eye = normalize(-v_position); // eye is in 0,0,0
      // TODO: to_eye shouldnt be hardcoded.
      vec3 to_light = normalize(vec3(0.7, -3.0, 1.0) - v_position);
      // no specular component for hands.
      float diffuse = shadow * max(dot(to_light, normal), 0.0) * 0.7;
      float ambient = 0.3;   
      fragColor = vec4(vec3(0.9, 0.9, 0.9) * (diffuse + ambient), 1.0);
    }`
  );
  gl.compileShader(pixel_shader);

  var program  = gl.createProgram();
  gl.attachShader(program, vertex_shader);
  gl.attachShader(program, pixel_shader);
  gl.linkProgram(program);
  console.log(gl.getShaderInfoLog(vertex_shader));
  console.log(gl.getShaderInfoLog(pixel_shader));
  console.log(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  gl.uniform1i(gl.getUniformLocation(program, "u_depth_texture"), 0);

  gl.render_u_mvp = gl.getUniformLocation(program, "u_mvp");
  gl.u_mvp_from_light = gl.getUniformLocation(program, "u_mvp_from_light");
  gl.u_draw_lighting = gl.getUniformLocation(program, "u_draw_lighting");  
  gl.render_u_pointSize = gl.getUniformLocation(program, "u_pointSize");
  gl.render_u_light_position = gl.getUniformLocation(program, "u_light_position");
  gl.render_u_shadow_map = gl.getUniformLocation(program, "u_shadow_map");
  gl.render_u_xz_flip = gl.getUniformLocation(program, "xz_flip");
  gl.uniform1i(gl.render_u_xz_flip, 0);
  
  function createDepthTexture(gl) {
    var depth_texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depth_texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    return depth_texture;  
  };
  // Upload the latest depth frame to this texture.
  gl.depth_texture = createDepthTexture(gl);
  if (drawGL)
    drawGL.depth_texture = createDepthTexture(drawGL);

  gl.render_program = program;
  gl.compute_program = compute_program;
  gl.transform_feedback = transform_feedback;
  gl.tf_bo = tf_bo;
}

function getMvpMatrix(screenwidth, screenheight) {
    var model = new mat4.create();
    var view = new mat4.create();
    mat4.lookAt(view,
        vec3.fromValues(0, 0, 0),   // eye
        vec3.fromValues(0, 0, 0.4),   // target
        vec3.fromValues(0, -1, 0));  // up

    var aspect = screenwidth / screenheight;
    var projection = new mat4.create();
    mat4.perspective(projection, glMatrix.toRadian(60.0), aspect, 0.1, 20.0);

    var mv = mat4.create();
    mat4.multiply(mv, view, model);

    var mvp = mat4.create();
    mat4.multiply(mvp, projection, mv);
    mat4.scale(mvp, mvp, [1.1, 1.1, 1]);
    return mvp;
}

let u_plane;
let tf_output;

// Analysis intermediate data.
// If != -1, marking that the point is connected to subsegment starting point,
// and the value is sub-segment starting point's index. Only skeleton points
// are procesed in the algorithm (speed concern) and only those have the values
// != -1 - see markConnectedPoints.
let links;


let out;
let out1;
let out2;
let width;
let height;
// The max length of a finger segment - determines the radius of circular
// propagation using generate_concentric_circles_indices.js (5 cm)
let segment_coef;

function processOnCPU() {
  links.fill(-1);
  segment_farthest_point_map_left = {};
  segment_farthest_point_map_right = {};
  const segment_data = {};
  const net_inv = INTERPOLATE_INV;
  const netw = Math.ceil(width * net_inv);
  const neth = Math.ceil(height * net_inv);
  const net = (out ? out.net : new Array(netw * neth)).fill(-1);

  // We limit the gesture processing to area of the screen with margins 60 for
  // screen size 640x480. This is to avoid the need of checking against the
  // screen bounds.
  const x_offset = Math.min(radius_offset.length, (width * 0.1) | 0, (height * 0.125) | 0);
  const y_offset = x_offset;
  const max_radius = x_offset;
  let x_count = width - (2 * x_offset);
  let y_end = height - y_offset;
  for (let row = y_offset; row < y_end; row++) {
    const row_offset = row * width;
    let x = row_offset + x_offset;
    const x_end = x + x_count;
    for (; x < x_end; ++x) {
      const value = tf_output[x];
      if (value < -1) {
        // Maintain the net of wide areas.
        const column = x - row_offset;
        const ncol = (column * net_inv) | 0;
        const nrow = (row * net_inv) | 0;
        const ni = netw * nrow + ncol;
        if (net[ni] == -1)
          net[ni] = (column << 16) | row;
        continue;
      } else if (value <= 0.0) {
        continue; // Far away pixel if 0, or pixel that is not on a bone if < 0.
      }
      if (links[x] > -1)
        continue; // If already on a segment.
      const depth = modf(value);  
      // Convert hand size from cm to pixels on given depth.
      const radius = Math.min(max_radius, segment_coef / depth * 0.8);
      markConnectedPoints(x, x - row_offset, row, radius, segment_data);
    }
  }
  out2 = out1;
  out1 = out;
  out = {segment_data: segment_data, net: net, netw: netw, neth: neth};
}

function markConnectedPoints(index, column, row, radius, segment_data) {
  connected.fill(false);
  connected[0] = true;
  links[index] = index;

  // farthest index left and right.
  let farthest_index_left = {index: index, x: column, y: row, center: {x: -1, y: -1}};
  let farthest_index_right = {index: index, x: column, y: row, center: {x: -1, y: -1}};
  let count_left = 0;
  let count_right = 0;

  for (var j = 1; j < radius; j++) {
    let had_connection_on_radius = false;  // Don't go further if there are no points to connect.
    const count_on_this_radius = count_per_radius[j];
    // generate_concentric_circles_indices.js generates full circle, and we want
    // to only go through lower half of the circle.
    const r_start = radius_offset[j] + (count_on_this_radius >> 2);
    const r_end = r_start + 1 + (count_on_this_radius >> 1);
    for (var i = r_start; i < r_end; i++) {
      const element_towards_center = towards_center[i];
      // We get the index of element towards center. If the point is not
      // connected to the center, don't bother analyzing it.
      if (!connected[element_towards_center])
        continue;
      let elem = index + xs[i] + ys[i] * width;
      const x_offset = xs[i];
      const y_offset = ys[i];
      let l = tf_output[elem];
      if (l != 0.0) {
        connected[i] = true;
        had_connection_on_radius = true;
        const x = column + x_offset;
        const y = row + y_offset;
        if (links[elem] > -1) {
          // continue as the point is already allocated to other segment.
          continue;
        }
        links[elem] = index;
        if (l < 0.0)
          continue; // The pixel is not on the finger bone. 
        // Track the farthest indices to the left and to the right.
        if (x_offset < 0) {
          if (l > 1.0) {
            farthest_index_left.center.x = x;
            farthest_index_left.center.y = y;
          }
          farthest_index_left.index = elem;
          farthest_index_left.x = x;
          farthest_index_left.y = y;
          count_left++;
        } else {
          if (l > 1.0) {
            farthest_index_right.center.x = x;
            farthest_index_right.center.y = y;
          }
          farthest_index_right.index = elem;
          farthest_index_right.x = x;
          farthest_index_right.y = y;
          count_right++;
        }
      }
    }
    if (!had_connection_on_radius)
      break;
  }

  let data = {x:column, y:row, index: index, far_left: farthest_index_left,
              far_right: farthest_index_right, count_left: count_left,
              count_right: count_right, depth: modf(tf_output[index])};
  farthest_index_left.depth = modf(tf_output[farthest_index_left.index]);
  farthest_index_right.depth = modf(tf_output[farthest_index_right.index]);

  segment_data[index] = data;
}

function modf(v) {
  return v - (v | 0);
}

// Generated using generate_concentric_circles_indices.js for kernel 60.
// This is used to enumerate through points on the same distance from the center,
// similar to spreading of vawes of concentric circles and for each point of
// the circle, use towards_center to calculate if the point is connected to the
// center.
var xs = [0,0,1,1,1,0,-1,-1,-1,0,1,2,2,2,2,2,1,0,-1,-2,-2,-2,-2,-2,-1,0,1,2,3,3,3,3,3,2,1,0,-1,-2,-3,-3,-3,-3,-3,-2,-1,0,1,2,3,4,4,4,4,4,3,2,1,0,-1,-2,-3,-4,-4,-4,-4,-4,-3,-2,-1,0,1,2,3,3,4,4,5,5,5,5,5,5,5,4,4,3,3,2,1,0,-1,-2,-3,-3,-4,-4,-5,-5,-5,-5,-5,-5,-5,-4,-4,-3,-3,-2,-1,0,1,2,3,4,5,6,6,6,6,6,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-6,-6,-6,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,5,6,6,7,7,7,7,7,7,7,6,6,5,5,4,3,2,1,0,-1,-2,-3,-4,-5,-5,-6,-6,-7,-7,-7,-7,-7,-7,-7,-6,-6,-5,-5,-4,-3,-2,-1,0,1,2,3,4,4,5,6,7,7,8,8,8,8,8,8,8,8,8,7,7,6,5,4,4,3,2,1,0,-1,-2,-3,-4,-4,-5,-6,-7,-7,-8,-8,-8,-8,-8,-8,-8,-8,-8,-7,-7,-6,-5,-4,-4,-3,-2,-1,0,1,2,3,4,5,6,7,7,8,9,9,9,9,9,9,9,9,9,8,7,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-7,-8,-9,-9,-9,-9,-9,-9,-9,-9,-9,-8,-7,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,6,7,8,8,9,9,10,10,10,10,10,10,10,10,10,9,9,8,8,7,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-7,-8,-8,-9,-9,-10,-10,-10,-10,-10,-10,-10,-10,-10,-9,-9,-8,-8,-7,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,11,11,11,11,11,11,11,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-11,-11,-11,-11,-11,-11,-11,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,9,10,10,11,11,12,12,12,12,12,12,12,12,12,11,11,10,10,9,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-9,-10,-10,-11,-11,-12,-12,-12,-12,-12,-12,-12,-12,-12,-11,-11,-10,-10,-9,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,5,6,7,7,8,9,10,11,11,12,12,12,13,13,13,13,13,13,13,13,13,13,13,12,12,12,11,11,10,9,8,7,7,6,5,5,4,3,2,1,0,-1,-2,-3,-4,-5,-5,-6,-7,-7,-8,-9,-10,-11,-11,-12,-12,-12,-13,-13,-13,-13,-13,-13,-13,-13,-13,-13,-13,-12,-12,-12,-11,-11,-10,-9,-8,-7,-7,-6,-5,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,11,12,13,13,14,14,14,14,14,14,14,14,14,14,14,13,13,12,11,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-11,-12,-13,-13,-14,-14,-14,-14,-14,-14,-14,-14,-14,-14,-14,-13,-13,-12,-11,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,12,12,13,13,14,14,15,15,15,15,15,15,15,15,15,15,15,14,14,13,13,12,12,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-12,-12,-13,-13,-14,-14,-15,-15,-15,-15,-15,-15,-15,-15,-15,-15,-15,-14,-14,-13,-13,-12,-12,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,14,15,15,16,16,16,16,16,16,16,16,16,16,16,15,15,14,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-14,-15,-15,-16,-16,-16,-16,-16,-16,-16,-16,-16,-16,-16,-15,-15,-14,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,10,11,11,12,13,13,14,14,15,15,16,16,16,17,17,17,17,17,17,17,17,17,17,17,16,16,16,15,15,14,14,13,13,12,11,11,10,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-10,-11,-11,-12,-13,-13,-14,-14,-15,-15,-16,-16,-16,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-16,-16,-16,-15,-15,-14,-14,-13,-13,-12,-11,-11,-10,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,6,7,8,9,10,10,11,12,13,14,15,15,16,16,17,17,17,18,18,18,18,18,18,18,18,18,18,18,18,18,17,17,17,16,16,15,15,14,13,12,11,10,10,9,8,7,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-15,-15,-16,-16,-17,-17,-17,-18,-18,-18,-18,-18,-18,-18,-18,-18,-18,-18,-18,-18,-17,-17,-17,-16,-16,-15,-15,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,14,15,15,16,17,17,18,18,19,19,19,19,19,19,19,19,19,19,19,19,19,18,18,17,17,16,15,15,14,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-14,-15,-15,-16,-17,-17,-18,-18,-19,-19,-19,-19,-19,-19,-19,-19,-19,-19,-19,-19,-19,-18,-18,-17,-17,-16,-15,-15,-14,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,15,16,16,17,17,18,18,19,19,20,20,20,20,20,20,20,20,20,20,20,20,20,19,19,18,18,17,17,16,16,15,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-16,-16,-17,-17,-18,-18,-19,-19,-20,-20,-20,-20,-20,-20,-20,-20,-20,-20,-20,-20,-20,-19,-19,-18,-18,-17,-17,-16,-16,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,11,12,13,14,15,15,16,16,17,18,18,19,19,19,20,20,20,21,21,21,21,21,21,21,21,21,21,21,21,21,20,20,20,19,19,19,18,18,17,16,16,15,15,14,13,12,11,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-11,-12,-13,-14,-15,-15,-16,-16,-17,-18,-18,-19,-19,-19,-20,-20,-20,-21,-21,-21,-21,-21,-21,-21,-21,-21,-21,-21,-21,-21,-20,-20,-20,-19,-19,-19,-18,-18,-17,-16,-16,-15,-15,-14,-13,-12,-11,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,14,15,16,17,17,18,18,19,20,20,21,21,21,22,22,22,22,22,22,22,22,22,22,22,22,22,21,21,21,20,20,19,18,18,17,17,16,15,14,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-14,-15,-16,-17,-17,-18,-18,-19,-20,-20,-21,-21,-21,-22,-22,-22,-22,-22,-22,-22,-22,-22,-22,-22,-22,-22,-21,-21,-21,-20,-20,-19,-18,-18,-17,-17,-16,-15,-14,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,19,20,20,21,21,22,22,22,23,23,23,23,23,23,23,23,23,23,23,23,23,22,22,22,21,21,20,20,19,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-19,-20,-20,-21,-21,-22,-22,-22,-23,-23,-23,-23,-23,-23,-23,-23,-23,-23,-23,-23,-23,-22,-22,-22,-21,-21,-20,-20,-19,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,17,18,18,19,19,20,21,21,22,22,23,23,23,24,24,24,24,24,24,24,24,24,24,24,24,24,23,23,23,22,22,21,21,20,19,19,18,18,17,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-17,-18,-18,-19,-19,-20,-21,-21,-22,-22,-23,-23,-23,-24,-24,-24,-24,-24,-24,-24,-24,-24,-24,-24,-24,-24,-23,-23,-23,-22,-22,-21,-21,-20,-19,-19,-18,-18,-17,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,7,8,9,10,11,12,12,13,14,15,15,16,17,18,19,20,20,21,21,22,22,23,23,23,24,24,24,25,25,25,25,25,25,25,25,25,25,25,25,25,25,25,24,24,24,23,23,23,22,22,21,21,20,20,19,18,17,16,15,15,14,13,12,12,11,10,9,8,7,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-20,-21,-21,-22,-22,-23,-23,-23,-24,-24,-24,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-25,-24,-24,-24,-23,-23,-23,-22,-22,-21,-21,-20,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,12,13,14,14,15,16,17,18,18,19,19,20,20,21,22,22,23,23,24,24,24,25,25,25,26,26,26,26,26,26,26,26,26,26,26,26,26,26,26,25,25,25,24,24,24,23,23,22,22,21,20,20,19,19,18,18,17,16,15,14,14,13,12,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-14,-15,-16,-17,-18,-18,-19,-19,-20,-20,-21,-22,-22,-23,-23,-24,-24,-24,-25,-25,-25,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-26,-25,-25,-25,-24,-24,-24,-23,-23,-22,-22,-21,-20,-20,-19,-19,-18,-18,-17,-16,-15,-14,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,20,21,21,22,22,23,24,24,25,25,26,26,26,27,27,27,27,27,27,27,27,27,27,27,27,27,27,27,26,26,26,25,25,24,24,23,22,22,21,21,20,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-21,-22,-22,-23,-24,-24,-25,-25,-26,-26,-26,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-27,-26,-26,-26,-25,-25,-24,-24,-23,-22,-22,-21,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,18,19,20,21,22,23,23,24,24,25,25,26,26,27,27,27,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,27,27,27,26,26,25,25,24,24,23,23,22,21,20,19,18,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-24,-25,-25,-26,-26,-27,-27,-27,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-28,-27,-27,-27,-26,-26,-25,-25,-24,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,19,20,20,21,21,22,22,23,23,24,25,25,26,26,27,27,27,28,28,28,29,29,29,29,29,29,29,29,29,29,29,29,29,29,29,28,28,28,27,27,27,26,26,25,25,24,23,23,22,22,21,21,20,20,19,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-19,-20,-20,-21,-21,-22,-22,-23,-23,-24,-25,-25,-26,-26,-27,-27,-27,-28,-28,-28,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-29,-28,-28,-28,-27,-27,-27,-26,-26,-25,-25,-24,-23,-23,-22,-22,-21,-21,-20,-20,-19,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,18,19,20,21,22,23,24,24,25,25,26,26,27,27,28,28,28,29,29,29,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,29,29,29,28,28,28,27,27,26,26,25,25,24,24,23,22,21,20,19,18,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-18,-19,-20,-21,-22,-23,-24,-24,-25,-25,-26,-26,-27,-27,-28,-28,-28,-29,-29,-29,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-30,-29,-29,-29,-28,-28,-28,-27,-27,-26,-26,-25,-25,-24,-24,-23,-22,-21,-20,-19,-18,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,11,12,13,14,15,16,17,17,18,19,20,21,21,22,22,23,23,24,24,25,26,26,27,27,28,28,29,29,29,30,30,30,30,31,31,31,31,31,31,31,31,31,31,31,31,31,31,31,30,30,30,30,29,29,29,28,28,27,27,26,26,25,24,24,23,23,22,22,21,21,20,19,18,17,17,16,15,14,13,12,11,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-21,-22,-22,-23,-23,-24,-24,-25,-26,-26,-27,-27,-28,-28,-29,-29,-29,-30,-30,-30,-30,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-31,-30,-30,-30,-30,-29,-29,-29,-28,-28,-27,-27,-26,-26,-25,-24,-24,-23,-23,-22,-22,-21,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,25,25,26,26,27,28,28,29,29,30,30,31,31,31,31,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,31,31,31,31,30,30,29,29,28,28,27,26,26,25,25,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-25,-25,-26,-26,-27,-28,-28,-29,-29,-30,-30,-31,-31,-31,-31,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-32,-31,-31,-31,-31,-30,-30,-29,-29,-28,-28,-27,-26,-26,-25,-25,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,19,20,21,22,23,23,24,24,25,25,26,27,27,28,28,29,29,30,30,31,31,32,32,32,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,32,32,32,31,31,30,30,29,29,28,28,27,27,26,25,25,24,24,23,23,22,21,20,19,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-19,-20,-21,-22,-23,-23,-24,-24,-25,-25,-26,-27,-27,-28,-28,-29,-29,-30,-30,-31,-31,-32,-32,-32,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-33,-32,-32,-32,-31,-31,-30,-30,-29,-29,-28,-28,-27,-27,-26,-25,-25,-24,-24,-23,-23,-22,-21,-20,-19,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,14,15,16,16,17,18,18,19,20,21,22,22,23,24,25,26,26,27,27,28,29,29,30,30,30,31,31,31,32,32,32,33,33,33,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,33,33,33,32,32,32,31,31,31,30,30,30,29,29,28,27,27,26,26,25,24,23,22,22,21,20,19,18,18,17,16,16,15,14,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-14,-15,-16,-16,-17,-18,-18,-19,-20,-21,-22,-22,-23,-24,-25,-26,-26,-27,-27,-28,-29,-29,-30,-30,-30,-31,-31,-31,-32,-32,-32,-33,-33,-33,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-34,-33,-33,-33,-32,-32,-32,-31,-31,-31,-30,-30,-30,-29,-29,-28,-27,-27,-26,-26,-25,-24,-23,-22,-22,-21,-20,-19,-18,-18,-17,-16,-16,-15,-14,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,21,22,23,24,25,26,27,28,28,29,29,30,31,31,32,32,33,33,33,34,34,34,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,34,34,34,33,33,33,32,32,31,31,30,29,29,28,28,27,26,25,24,23,22,21,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-27,-28,-28,-29,-29,-30,-31,-31,-32,-32,-33,-33,-33,-34,-34,-34,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-35,-34,-34,-34,-33,-33,-33,-32,-32,-31,-31,-30,-29,-29,-28,-28,-27,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,24,25,25,26,26,27,27,28,28,29,30,30,31,31,32,32,33,33,34,34,34,35,35,35,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,35,35,35,34,34,34,33,33,32,32,31,31,30,30,29,28,28,27,27,26,26,25,25,24,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-24,-25,-25,-26,-26,-27,-27,-28,-28,-29,-30,-30,-31,-31,-32,-32,-33,-33,-34,-34,-34,-35,-35,-35,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-36,-35,-35,-35,-34,-34,-34,-33,-33,-32,-32,-31,-31,-30,-30,-29,-28,-28,-27,-27,-26,-26,-25,-25,-24,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,15,16,17,18,19,20,21,22,23,23,24,25,26,27,28,29,29,30,30,31,32,32,33,33,34,34,35,35,35,36,36,36,36,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,36,36,36,36,35,35,35,34,34,33,33,32,32,31,30,30,29,29,28,27,26,25,24,23,23,22,21,20,19,18,17,16,15,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-28,-29,-29,-30,-30,-31,-32,-32,-33,-33,-34,-34,-35,-35,-35,-36,-36,-36,-36,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-37,-36,-36,-36,-36,-35,-35,-35,-34,-34,-33,-33,-32,-32,-31,-30,-30,-29,-29,-28,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,19,20,21,22,22,23,24,25,26,26,27,27,28,28,29,29,30,31,31,32,32,33,33,34,34,34,35,35,35,36,36,37,37,37,37,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,37,37,37,37,36,36,35,35,35,34,34,34,33,33,32,32,31,31,30,29,29,28,28,27,27,26,26,25,24,23,22,22,21,20,19,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-19,-20,-21,-22,-22,-23,-24,-25,-26,-26,-27,-27,-28,-28,-29,-29,-30,-31,-31,-32,-32,-33,-33,-34,-34,-34,-35,-35,-35,-36,-36,-37,-37,-37,-37,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-38,-37,-37,-37,-37,-36,-36,-35,-35,-35,-34,-34,-34,-33,-33,-32,-32,-31,-31,-30,-29,-29,-28,-28,-27,-27,-26,-26,-25,-24,-23,-22,-22,-21,-20,-19,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,19,20,21,21,22,23,24,25,25,26,27,28,29,30,30,31,31,32,33,33,34,34,35,35,36,36,36,37,37,37,38,38,38,38,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,38,38,38,38,37,37,37,36,36,36,35,35,34,34,33,33,32,31,31,30,30,29,28,27,26,25,25,24,23,22,21,21,20,19,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-25,-26,-27,-28,-29,-30,-30,-31,-31,-32,-33,-33,-34,-34,-35,-35,-36,-36,-36,-37,-37,-37,-38,-38,-38,-38,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-39,-38,-38,-38,-38,-37,-37,-37,-36,-36,-36,-35,-35,-34,-34,-33,-33,-32,-31,-31,-30,-30,-29,-28,-27,-26,-25,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,24,25,26,27,28,29,30,31,32,32,33,33,34,35,35,36,36,37,37,38,38,38,39,39,39,39,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,39,39,39,39,38,38,38,37,37,36,36,35,35,34,33,33,32,32,31,30,29,28,27,26,25,24,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-27,-28,-29,-30,-31,-32,-32,-33,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-38,-39,-39,-39,-39,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-40,-39,-39,-39,-39,-38,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-33,-32,-32,-31,-30,-29,-28,-27,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,23,24,25,26,27,27,28,28,29,29,30,30,31,31,32,32,33,34,34,35,35,36,36,37,37,38,38,39,39,39,40,40,40,40,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,40,40,40,40,39,39,39,38,38,37,37,36,36,35,35,34,34,33,32,32,31,31,30,30,29,29,28,28,27,27,26,25,24,23,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-27,-28,-28,-29,-29,-30,-30,-31,-31,-32,-32,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-39,-40,-40,-40,-40,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-40,-40,-40,-40,-39,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-32,-32,-31,-31,-30,-30,-29,-29,-28,-28,-27,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,18,19,20,20,21,22,23,24,25,26,26,27,28,29,30,31,32,33,33,34,34,35,36,36,37,37,38,38,38,39,39,39,40,40,40,41,41,41,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,41,41,41,40,40,40,39,39,39,38,38,38,37,37,36,36,35,34,34,33,33,32,31,30,29,28,27,26,26,25,24,23,22,21,20,20,19,18,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-18,-19,-20,-20,-21,-22,-23,-24,-25,-26,-26,-27,-28,-29,-30,-31,-32,-33,-33,-34,-34,-35,-36,-36,-37,-37,-38,-38,-38,-39,-39,-39,-40,-40,-40,-41,-41,-41,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-41,-41,-41,-40,-40,-40,-39,-39,-39,-38,-38,-38,-37,-37,-36,-36,-35,-34,-34,-33,-33,-32,-31,-30,-29,-28,-27,-26,-26,-25,-24,-23,-22,-21,-20,-20,-19,-18,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,20,21,22,22,23,24,25,25,26,27,28,29,29,30,30,31,31,32,32,33,33,34,35,35,36,36,37,37,38,38,39,39,40,40,40,41,41,41,42,42,42,42,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,42,42,42,42,41,41,41,40,40,40,39,39,38,38,37,37,36,36,35,35,34,33,33,32,32,31,31,30,30,29,29,28,27,26,25,25,24,23,22,22,21,20,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-22,-23,-24,-25,-25,-26,-27,-28,-29,-29,-30,-30,-31,-31,-32,-32,-33,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-40,-40,-40,-41,-41,-41,-42,-42,-42,-42,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-42,-42,-42,-42,-41,-41,-41,-40,-40,-40,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-33,-32,-32,-31,-31,-30,-30,-29,-29,-28,-27,-26,-25,-25,-24,-23,-22,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,18,19,20,21,22,23,24,24,25,26,27,28,28,29,30,31,32,33,34,34,35,35,36,37,37,38,38,39,39,40,40,41,41,41,42,42,42,43,43,43,43,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,43,43,43,43,42,42,42,41,41,41,40,40,39,39,38,38,37,37,36,35,35,34,34,33,32,31,30,29,28,28,27,26,25,24,24,23,22,21,20,19,18,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-27,-28,-28,-29,-30,-31,-32,-33,-34,-34,-35,-35,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-41,-42,-42,-42,-43,-43,-43,-43,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-43,-43,-43,-43,-42,-42,-42,-41,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-35,-35,-34,-34,-33,-32,-31,-30,-29,-28,-28,-27,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,27,28,29,30,31,32,32,33,33,34,35,36,36,37,37,38,39,39,40,40,41,41,42,42,43,43,43,44,44,44,44,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,44,44,44,44,43,43,43,42,42,41,41,40,40,39,39,38,37,37,36,36,35,34,33,33,32,32,31,30,29,28,27,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-27,-28,-29,-30,-31,-32,-32,-33,-33,-34,-35,-36,-36,-37,-37,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-43,-43,-44,-44,-44,-44,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-44,-44,-44,-44,-43,-43,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-37,-37,-36,-36,-35,-34,-33,-33,-32,-32,-31,-30,-29,-28,-27,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,21,22,23,24,25,26,26,27,28,29,30,30,31,31,32,33,34,34,35,35,36,36,37,38,38,39,39,40,40,41,41,42,42,42,43,43,44,44,44,45,45,45,45,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,45,45,45,45,44,44,44,43,43,42,42,42,41,41,40,40,39,39,38,38,37,36,36,35,35,34,34,33,32,31,31,30,30,29,28,27,26,26,25,24,23,22,21,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-26,-27,-28,-29,-30,-30,-31,-31,-32,-33,-34,-34,-35,-35,-36,-36,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-42,-42,-43,-43,-44,-44,-44,-45,-45,-45,-45,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-45,-45,-45,-45,-44,-44,-44,-43,-43,-42,-42,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-36,-36,-35,-35,-34,-34,-33,-32,-31,-31,-30,-30,-29,-28,-27,-26,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,19,20,21,22,23,23,24,25,26,27,28,29,29,30,31,32,33,34,35,36,37,37,38,38,39,40,40,41,41,42,42,43,43,43,44,44,44,45,45,45,46,46,46,46,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,46,46,46,46,45,45,45,44,44,44,43,43,43,42,42,41,41,40,40,39,38,38,37,37,36,35,34,33,32,31,30,29,29,28,27,26,25,24,23,23,22,21,20,19,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-28,-29,-29,-30,-31,-32,-33,-34,-35,-36,-37,-37,-38,-38,-39,-40,-40,-41,-41,-42,-42,-43,-43,-43,-44,-44,-44,-45,-45,-45,-46,-46,-46,-46,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-46,-46,-46,-46,-45,-45,-45,-44,-44,-44,-43,-43,-43,-42,-42,-41,-41,-40,-40,-39,-38,-38,-37,-37,-36,-35,-34,-33,-32,-31,-30,-29,-29,-28,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,25,26,27,28,28,29,30,31,32,32,33,33,34,34,35,35,36,36,37,37,38,39,39,40,40,41,41,42,42,43,43,44,44,45,45,45,46,46,46,47,47,47,47,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,47,47,47,47,46,46,46,45,45,45,44,44,43,43,42,42,41,41,40,40,39,39,38,37,37,36,36,35,35,34,34,33,33,32,32,31,30,29,28,28,27,26,25,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-25,-26,-27,-28,-28,-29,-30,-31,-32,-32,-33,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-43,-44,-44,-45,-45,-45,-46,-46,-46,-47,-47,-47,-47,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-47,-47,-47,-47,-46,-46,-46,-45,-45,-45,-44,-44,-43,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-33,-32,-32,-31,-30,-29,-28,-28,-27,-26,-25,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,20,21,22,23,24,25,26,27,27,28,29,30,31,31,32,33,34,35,36,37,38,38,39,39,40,41,41,42,42,43,43,44,44,45,45,46,46,46,47,47,47,47,48,48,48,48,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,48,48,48,48,47,47,47,47,46,46,46,45,45,44,44,43,43,42,42,41,41,40,39,39,38,38,37,36,35,34,33,32,31,31,30,29,28,27,27,26,25,24,23,22,21,20,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-27,-28,-29,-30,-31,-31,-32,-33,-34,-35,-36,-37,-38,-38,-39,-39,-40,-41,-41,-42,-42,-43,-43,-44,-44,-45,-45,-46,-46,-46,-47,-47,-47,-47,-48,-48,-48,-48,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-48,-48,-48,-48,-47,-47,-47,-47,-46,-46,-46,-45,-45,-44,-44,-43,-43,-42,-42,-41,-41,-40,-39,-39,-38,-38,-37,-36,-35,-34,-33,-32,-31,-31,-30,-29,-28,-27,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,12,13,14,14,15,16,17,18,19,20,21,22,22,23,24,25,26,27,28,29,30,30,31,32,33,34,34,35,35,36,36,37,37,38,38,39,40,40,41,41,42,43,43,44,44,45,45,46,46,46,47,47,48,48,48,48,49,49,49,49,49,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,49,49,49,49,49,48,48,48,48,47,47,46,46,46,45,45,44,44,43,43,42,41,41,40,40,39,38,38,37,37,36,36,35,35,34,34,33,32,31,30,30,29,28,27,26,25,24,23,22,22,21,20,19,18,17,16,15,14,14,13,12,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-14,-15,-16,-17,-18,-19,-20,-21,-22,-22,-23,-24,-25,-26,-27,-28,-29,-30,-30,-31,-32,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-40,-40,-41,-41,-42,-43,-43,-44,-44,-45,-45,-46,-46,-46,-47,-47,-48,-48,-48,-48,-49,-49,-49,-49,-49,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-49,-49,-49,-49,-49,-48,-48,-48,-48,-47,-47,-46,-46,-46,-45,-45,-44,-44,-43,-43,-42,-41,-41,-40,-40,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-32,-31,-30,-30,-29,-28,-27,-26,-25,-24,-23,-22,-22,-21,-20,-19,-18,-17,-16,-15,-14,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,24,25,26,26,27,28,29,29,30,31,32,33,33,34,35,36,37,38,39,39,40,40,41,42,42,43,43,44,44,45,45,45,46,46,47,47,47,48,48,49,49,49,50,50,50,50,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,50,50,50,50,49,49,49,48,48,47,47,47,46,46,45,45,45,44,44,43,43,42,42,41,40,40,39,39,38,37,36,35,34,33,33,32,31,30,29,29,28,27,26,26,25,24,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-26,-27,-28,-29,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-38,-39,-39,-40,-40,-41,-42,-42,-43,-43,-44,-44,-45,-45,-45,-46,-46,-47,-47,-47,-48,-48,-49,-49,-49,-50,-50,-50,-50,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-50,-50,-50,-50,-49,-49,-49,-48,-48,-47,-47,-47,-46,-46,-45,-45,-45,-44,-44,-43,-43,-42,-42,-41,-40,-40,-39,-39,-38,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-29,-28,-27,-26,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,25,26,27,28,29,30,31,32,32,33,34,35,36,37,38,39,40,41,41,42,42,43,44,44,45,46,46,47,47,48,48,48,49,49,49,50,50,50,51,51,51,51,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,51,51,51,51,50,50,50,49,49,49,48,48,48,47,47,46,46,45,44,44,43,42,42,41,41,40,39,38,37,36,35,34,33,32,32,31,30,29,28,27,26,25,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-32,-32,-33,-34,-35,-36,-37,-38,-39,-40,-41,-41,-42,-42,-43,-44,-44,-45,-46,-46,-47,-47,-48,-48,-48,-49,-49,-49,-50,-50,-50,-51,-51,-51,-51,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-51,-51,-51,-51,-50,-50,-50,-49,-49,-49,-48,-48,-48,-47,-47,-46,-46,-45,-44,-44,-43,-42,-42,-41,-41,-40,-39,-38,-37,-36,-35,-34,-33,-32,-32,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,28,29,30,31,31,32,33,34,35,35,36,36,37,37,38,38,39,39,40,40,41,41,42,43,43,44,44,45,45,46,46,47,47,48,48,49,49,50,50,50,51,51,51,52,52,52,52,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,52,52,52,52,51,51,51,50,50,50,49,49,48,48,47,47,46,46,45,45,44,44,43,43,42,41,41,40,40,39,39,38,38,37,37,36,36,35,35,34,33,32,31,31,30,29,28,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-28,-29,-30,-31,-31,-32,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-43,-43,-44,-44,-45,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-50,-51,-51,-51,-52,-52,-52,-52,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-52,-52,-52,-52,-51,-51,-51,-50,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-45,-44,-44,-43,-43,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-32,-31,-31,-30,-29,-28,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,30,31,32,33,34,34,35,36,37,38,39,40,41,42,42,43,43,44,45,45,46,46,47,47,48,48,49,49,50,50,51,51,51,52,52,52,53,53,53,53,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,53,53,53,53,52,52,52,51,51,51,50,50,49,49,48,48,47,47,46,46,45,45,44,43,43,42,42,41,40,39,38,37,36,35,34,34,33,32,31,30,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-30,-31,-32,-33,-34,-34,-35,-36,-37,-38,-39,-40,-41,-42,-42,-43,-43,-44,-45,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-51,-51,-51,-52,-52,-52,-53,-53,-53,-53,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-53,-53,-53,-53,-52,-52,-52,-51,-51,-51,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-45,-44,-43,-43,-42,-42,-41,-40,-39,-38,-37,-36,-35,-34,-34,-33,-32,-31,-30,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,18,19,20,21,22,23,23,24,25,25,26,27,27,28,29,30,31,32,33,33,34,35,36,37,37,38,38,39,39,40,40,41,41,42,42,43,44,44,45,45,46,47,47,48,48,49,49,49,50,50,50,51,51,51,52,52,52,53,53,53,53,54,54,54,54,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,54,54,54,54,53,53,53,53,52,52,52,51,51,51,50,50,50,49,49,49,48,48,47,47,46,45,45,44,44,43,42,42,41,41,40,40,39,39,38,38,37,37,36,35,34,33,33,32,31,30,29,28,27,27,26,25,25,24,23,23,22,21,20,19,18,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-18,-19,-20,-21,-22,-23,-23,-24,-25,-25,-26,-27,-27,-28,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-44,-44,-45,-45,-46,-47,-47,-48,-48,-49,-49,-49,-50,-50,-50,-51,-51,-51,-52,-52,-52,-53,-53,-53,-53,-54,-54,-54,-54,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-54,-54,-54,-54,-53,-53,-53,-53,-52,-52,-52,-51,-51,-51,-50,-50,-50,-49,-49,-49,-48,-48,-47,-47,-46,-45,-45,-44,-44,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-28,-27,-27,-26,-25,-25,-24,-23,-23,-22,-21,-20,-19,-18,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,29,30,31,32,32,33,34,35,36,36,37,38,39,40,41,42,43,43,44,44,45,46,46,47,47,48,48,49,49,50,50,51,51,52,52,52,53,53,54,54,54,54,55,55,55,55,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,55,55,55,55,54,54,54,54,53,53,52,52,52,51,51,50,50,49,49,48,48,47,47,46,46,45,44,44,43,43,42,41,40,39,38,37,36,36,35,34,33,32,32,31,30,29,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-29,-30,-31,-32,-32,-33,-34,-35,-36,-36,-37,-38,-39,-40,-41,-42,-43,-43,-44,-44,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-51,-51,-52,-52,-52,-53,-53,-54,-54,-54,-54,-55,-55,-55,-55,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-55,-55,-55,-55,-54,-54,-54,-54,-53,-53,-52,-52,-52,-51,-51,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-44,-44,-43,-43,-42,-41,-40,-39,-38,-37,-36,-36,-35,-34,-33,-32,-32,-31,-30,-29,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,19,20,21,21,22,23,24,25,26,27,28,29,30,31,31,32,33,34,35,35,36,37,38,39,40,41,41,42,43,44,45,45,46,46,47,48,48,49,49,50,50,51,51,52,52,53,53,53,54,54,54,55,55,55,55,56,56,56,56,56,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,56,56,56,56,56,55,55,55,55,54,54,54,53,53,53,52,52,51,51,50,50,49,49,48,48,47,46,46,45,45,44,43,42,41,41,40,39,38,37,36,35,35,34,33,32,31,31,30,29,28,27,26,25,24,23,22,21,21,20,19,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-31,-32,-33,-34,-35,-35,-36,-37,-38,-39,-40,-41,-41,-42,-43,-44,-45,-45,-46,-46,-47,-48,-48,-49,-49,-50,-50,-51,-51,-52,-52,-53,-53,-53,-54,-54,-54,-55,-55,-55,-55,-56,-56,-56,-56,-56,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-56,-56,-56,-56,-56,-55,-55,-55,-55,-54,-54,-54,-53,-53,-53,-52,-52,-51,-51,-50,-50,-49,-49,-48,-48,-47,-46,-46,-45,-45,-44,-43,-42,-41,-41,-40,-39,-38,-37,-36,-35,-35,-34,-33,-32,-31,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,34,35,36,37,38,38,39,39,40,40,41,42,42,43,43,44,44,45,45,46,47,47,48,48,49,50,50,51,51,52,52,53,53,54,54,55,55,55,56,56,56,57,57,57,57,57,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,57,57,57,57,57,56,56,56,55,55,55,54,54,53,53,52,52,51,51,50,50,49,48,48,47,47,46,45,45,44,44,43,43,42,42,41,40,40,39,39,38,38,37,36,35,34,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-32,-33,-34,-34,-35,-36,-37,-38,-38,-39,-39,-40,-40,-41,-42,-42,-43,-43,-44,-44,-45,-45,-46,-47,-47,-48,-48,-49,-50,-50,-51,-51,-52,-52,-53,-53,-54,-54,-55,-55,-55,-56,-56,-56,-57,-57,-57,-57,-57,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-57,-57,-57,-57,-57,-56,-56,-56,-55,-55,-55,-54,-54,-53,-53,-52,-52,-51,-51,-50,-50,-49,-48,-48,-47,-47,-46,-45,-45,-44,-44,-43,-43,-42,-42,-41,-40,-40,-39,-39,-38,-38,-37,-36,-35,-34,-34,-33,-32,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,26,27,28,28,29,30,31,32,33,33,34,35,36,37,37,38,39,40,41,42,43,44,45,46,46,47,47,48,49,49,50,50,51,51,52,52,53,53,53,54,54,54,55,55,56,56,56,57,57,57,58,58,58,58,58,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,58,58,58,58,58,57,57,57,56,56,56,55,55,54,54,54,53,53,53,52,52,51,51,50,50,49,49,48,47,47,46,46,45,44,43,42,41,40,39,38,37,37,36,35,34,33,33,32,31,30,29,28,28,27,26,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-26,-27,-28,-28,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-37,-38,-39,-40,-41,-42,-43,-44,-45,-46,-46,-47,-47,-48,-49,-49,-50,-50,-51,-51,-52,-52,-53,-53,-53,-54,-54,-54,-55,-55,-56,-56,-56,-57,-57,-57,-58,-58,-58,-58,-58,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-58,-58,-58,-58,-58,-57,-57,-57,-56,-56,-56,-55,-55,-54,-54,-54,-53,-53,-53,-52,-52,-51,-51,-50,-50,-49,-49,-48,-47,-47,-46,-46,-45,-44,-43,-42,-41,-40,-39,-38,-37,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-28,-28,-27,-26,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1];
var ys = [0,-1,-1,0,1,1,1,0,-1,-2,-2,-2,-1,0,1,2,2,2,2,2,1,0,-1,-2,-2,-3,-3,-3,-2,-1,0,1,2,3,3,3,3,3,2,1,0,-1,-2,-3,-3,-4,-4,-4,-3,-2,-1,0,1,2,3,4,4,4,4,4,3,2,1,0,-1,-2,-3,-4,-4,-5,-5,-5,-5,-4,-4,-3,-3,-2,-1,0,1,2,3,3,4,4,5,5,5,5,5,5,5,4,4,3,3,2,1,0,-1,-2,-3,-3,-4,-4,-5,-5,-5,-6,-6,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,6,6,6,6,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-6,-7,-7,-7,-7,-6,-6,-5,-5,-4,-3,-2,-1,0,1,2,3,4,5,5,6,6,7,7,7,7,7,7,7,6,6,5,5,4,3,2,1,0,-1,-2,-3,-4,-5,-5,-6,-6,-7,-7,-7,-8,-8,-8,-8,-8,-7,-7,-6,-5,-4,-4,-3,-2,-1,0,1,2,3,4,4,5,6,7,7,8,8,8,8,8,8,8,8,8,7,7,6,5,4,4,3,2,1,0,-1,-2,-3,-4,-4,-5,-6,-7,-7,-8,-8,-8,-8,-9,-9,-9,-9,-9,-8,-7,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,7,8,9,9,9,9,9,9,9,9,9,8,7,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-7,-8,-9,-9,-9,-9,-10,-10,-10,-10,-10,-9,-9,-8,-8,-7,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,6,7,8,8,9,9,10,10,10,10,10,10,10,10,10,9,9,8,8,7,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-7,-8,-8,-9,-9,-10,-10,-10,-10,-11,-11,-11,-11,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,11,11,11,11,11,11,11,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-11,-11,-11,-12,-12,-12,-12,-12,-11,-11,-10,-10,-9,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,9,10,10,11,11,12,12,12,12,12,12,12,12,12,11,11,10,10,9,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-9,-10,-10,-11,-11,-12,-12,-12,-12,-13,-13,-13,-13,-13,-13,-12,-12,-12,-11,-11,-10,-9,-8,-7,-7,-6,-5,-5,-4,-3,-2,-1,0,1,2,3,4,5,5,6,7,7,8,9,10,11,11,12,12,12,13,13,13,13,13,13,13,13,13,13,13,12,12,12,11,11,10,9,8,7,7,6,5,5,4,3,2,1,0,-1,-2,-3,-4,-5,-5,-6,-7,-7,-8,-9,-10,-11,-11,-12,-12,-12,-13,-13,-13,-13,-13,-14,-14,-14,-14,-14,-14,-13,-13,-12,-11,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,11,12,13,13,14,14,14,14,14,14,14,14,14,14,14,13,13,12,11,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-11,-12,-13,-13,-14,-14,-14,-14,-14,-15,-15,-15,-15,-15,-15,-14,-14,-13,-13,-12,-12,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,12,12,13,13,14,14,15,15,15,15,15,15,15,15,15,15,15,14,14,13,13,12,12,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-12,-12,-13,-13,-14,-14,-15,-15,-15,-15,-15,-16,-16,-16,-16,-16,-16,-15,-15,-14,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,14,15,15,16,16,16,16,16,16,16,16,16,16,16,15,15,14,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-14,-15,-15,-16,-16,-16,-16,-16,-17,-17,-17,-17,-17,-17,-16,-16,-16,-15,-15,-14,-14,-13,-13,-12,-11,-11,-10,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,10,11,11,12,13,13,14,14,15,15,16,16,16,17,17,17,17,17,17,17,17,17,17,17,16,16,16,15,15,14,14,13,13,12,11,11,10,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-10,-11,-11,-12,-13,-13,-14,-14,-15,-15,-16,-16,-16,-17,-17,-17,-17,-17,-18,-18,-18,-18,-18,-18,-18,-17,-17,-17,-16,-16,-15,-15,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,6,7,8,9,10,10,11,12,13,14,15,15,16,16,17,17,17,18,18,18,18,18,18,18,18,18,18,18,18,18,17,17,17,16,16,15,15,14,13,12,11,10,10,9,8,7,6,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-15,-15,-16,-16,-17,-17,-17,-18,-18,-18,-18,-18,-18,-19,-19,-19,-19,-19,-19,-19,-18,-18,-17,-17,-16,-15,-15,-14,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,14,15,15,16,17,17,18,18,19,19,19,19,19,19,19,19,19,19,19,19,19,18,18,17,17,16,15,15,14,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-14,-15,-15,-16,-17,-17,-18,-18,-19,-19,-19,-19,-19,-19,-20,-20,-20,-20,-20,-20,-20,-19,-19,-18,-18,-17,-17,-16,-16,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,15,16,16,17,17,18,18,19,19,20,20,20,20,20,20,20,20,20,20,20,20,20,19,19,18,18,17,17,16,16,15,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-16,-16,-17,-17,-18,-18,-19,-19,-20,-20,-20,-20,-20,-20,-21,-21,-21,-21,-21,-21,-21,-20,-20,-20,-19,-19,-19,-18,-18,-17,-16,-16,-15,-15,-14,-13,-12,-11,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,11,12,13,14,15,15,16,16,17,18,18,19,19,19,20,20,20,21,21,21,21,21,21,21,21,21,21,21,21,21,20,20,20,19,19,19,18,18,17,16,16,15,15,14,13,12,11,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-11,-12,-13,-14,-15,-15,-16,-16,-17,-18,-18,-19,-19,-19,-20,-20,-20,-21,-21,-21,-21,-21,-21,-22,-22,-22,-22,-22,-22,-22,-21,-21,-21,-20,-20,-19,-18,-18,-17,-17,-16,-15,-14,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,14,15,16,17,17,18,18,19,20,20,21,21,21,22,22,22,22,22,22,22,22,22,22,22,22,22,21,21,21,20,20,19,18,18,17,17,16,15,14,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-14,-15,-16,-17,-17,-18,-18,-19,-20,-20,-21,-21,-21,-22,-22,-22,-22,-22,-22,-23,-23,-23,-23,-23,-23,-23,-22,-22,-22,-21,-21,-20,-20,-19,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,19,20,20,21,21,22,22,22,23,23,23,23,23,23,23,23,23,23,23,23,23,22,22,22,21,21,20,20,19,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-19,-20,-20,-21,-21,-22,-22,-22,-23,-23,-23,-23,-23,-23,-24,-24,-24,-24,-24,-24,-24,-23,-23,-23,-22,-22,-21,-21,-20,-19,-19,-18,-18,-17,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,17,18,18,19,19,20,21,21,22,22,23,23,23,24,24,24,24,24,24,24,24,24,24,24,24,24,23,23,23,22,22,21,21,20,19,19,18,18,17,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-17,-18,-18,-19,-19,-20,-21,-21,-22,-22,-23,-23,-23,-24,-24,-24,-24,-24,-24,-25,-25,-25,-25,-25,-25,-25,-25,-24,-24,-24,-23,-23,-23,-22,-22,-21,-21,-20,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,7,8,9,10,11,12,12,13,14,15,15,16,17,18,19,20,20,21,21,22,22,23,23,23,24,24,24,25,25,25,25,25,25,25,25,25,25,25,25,25,25,25,24,24,24,23,23,23,22,22,21,21,20,20,19,18,17,16,15,15,14,13,12,12,11,10,9,8,7,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-20,-21,-21,-22,-22,-23,-23,-23,-24,-24,-24,-25,-25,-25,-25,-25,-25,-25,-26,-26,-26,-26,-26,-26,-26,-26,-25,-25,-25,-24,-24,-24,-23,-23,-22,-22,-21,-20,-20,-19,-19,-18,-18,-17,-16,-15,-14,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,12,13,14,14,15,16,17,18,18,19,19,20,20,21,22,22,23,23,24,24,24,25,25,25,26,26,26,26,26,26,26,26,26,26,26,26,26,26,26,25,25,25,24,24,24,23,23,22,22,21,20,20,19,19,18,18,17,16,15,14,14,13,12,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-14,-15,-16,-17,-18,-18,-19,-19,-20,-20,-21,-22,-22,-23,-23,-24,-24,-24,-25,-25,-25,-26,-26,-26,-26,-26,-26,-26,-27,-27,-27,-27,-27,-27,-27,-27,-26,-26,-26,-25,-25,-24,-24,-23,-22,-22,-21,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,20,21,21,22,22,23,24,24,25,25,26,26,26,27,27,27,27,27,27,27,27,27,27,27,27,27,27,27,26,26,26,25,25,24,24,23,22,22,21,21,20,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-21,-22,-22,-23,-24,-24,-25,-25,-26,-26,-26,-27,-27,-27,-27,-27,-27,-27,-28,-28,-28,-28,-28,-28,-28,-28,-27,-27,-27,-26,-26,-25,-25,-24,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,18,19,20,21,22,23,23,24,24,25,25,26,26,27,27,27,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,27,27,27,26,26,25,25,24,24,23,23,22,21,20,19,18,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-24,-25,-25,-26,-26,-27,-27,-27,-28,-28,-28,-28,-28,-28,-28,-29,-29,-29,-29,-29,-29,-29,-29,-28,-28,-28,-27,-27,-27,-26,-26,-25,-25,-24,-23,-23,-22,-22,-21,-21,-20,-20,-19,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,19,20,20,21,21,22,22,23,23,24,25,25,26,26,27,27,27,28,28,28,29,29,29,29,29,29,29,29,29,29,29,29,29,29,29,28,28,28,27,27,27,26,26,25,25,24,23,23,22,22,21,21,20,20,19,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-19,-20,-20,-21,-21,-22,-22,-23,-23,-24,-25,-25,-26,-26,-27,-27,-27,-28,-28,-28,-29,-29,-29,-29,-29,-29,-29,-30,-30,-30,-30,-30,-30,-30,-30,-29,-29,-29,-28,-28,-28,-27,-27,-26,-26,-25,-25,-24,-24,-23,-22,-21,-20,-19,-18,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,18,19,20,21,22,23,24,24,25,25,26,26,27,27,28,28,28,29,29,29,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,29,29,29,28,28,28,27,27,26,26,25,25,24,24,23,22,21,20,19,18,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-18,-19,-20,-21,-22,-23,-24,-24,-25,-25,-26,-26,-27,-27,-28,-28,-28,-29,-29,-29,-30,-30,-30,-30,-30,-30,-30,-31,-31,-31,-31,-31,-31,-31,-31,-30,-30,-30,-30,-29,-29,-29,-28,-28,-27,-27,-26,-26,-25,-24,-24,-23,-23,-22,-22,-21,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,11,12,13,14,15,16,17,17,18,19,20,21,21,22,22,23,23,24,24,25,26,26,27,27,28,28,29,29,29,30,30,30,30,31,31,31,31,31,31,31,31,31,31,31,31,31,31,31,30,30,30,30,29,29,29,28,28,27,27,26,26,25,24,24,23,23,22,22,21,21,20,19,18,17,17,16,15,14,13,12,11,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-21,-22,-22,-23,-23,-24,-24,-25,-26,-26,-27,-27,-28,-28,-29,-29,-29,-30,-30,-30,-30,-31,-31,-31,-31,-31,-31,-31,-32,-32,-32,-32,-32,-32,-32,-32,-32,-31,-31,-31,-31,-30,-30,-29,-29,-28,-28,-27,-26,-26,-25,-25,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,25,25,26,26,27,28,28,29,29,30,30,31,31,31,31,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,32,31,31,31,31,30,30,29,29,28,28,27,26,26,25,25,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-25,-25,-26,-26,-27,-28,-28,-29,-29,-30,-30,-31,-31,-31,-31,-32,-32,-32,-32,-32,-32,-32,-32,-33,-33,-33,-33,-33,-33,-33,-33,-33,-32,-32,-32,-31,-31,-30,-30,-29,-29,-28,-28,-27,-27,-26,-25,-25,-24,-24,-23,-23,-22,-21,-20,-19,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,19,20,21,22,23,23,24,24,25,25,26,27,27,28,28,29,29,30,30,31,31,32,32,32,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,33,32,32,32,31,31,30,30,29,29,28,28,27,27,26,25,25,24,24,23,23,22,21,20,19,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-19,-20,-21,-22,-23,-23,-24,-24,-25,-25,-26,-27,-27,-28,-28,-29,-29,-30,-30,-31,-31,-32,-32,-32,-33,-33,-33,-33,-33,-33,-33,-33,-34,-34,-34,-34,-34,-34,-34,-34,-34,-33,-33,-33,-32,-32,-32,-31,-31,-31,-30,-30,-30,-29,-29,-28,-27,-27,-26,-26,-25,-24,-23,-22,-22,-21,-20,-19,-18,-18,-17,-16,-16,-15,-14,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,14,15,16,16,17,18,18,19,20,21,22,22,23,24,25,26,26,27,27,28,29,29,30,30,30,31,31,31,32,32,32,33,33,33,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,34,33,33,33,32,32,32,31,31,31,30,30,30,29,29,28,27,27,26,26,25,24,23,22,22,21,20,19,18,18,17,16,16,15,14,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-14,-15,-16,-16,-17,-18,-18,-19,-20,-21,-22,-22,-23,-24,-25,-26,-26,-27,-27,-28,-29,-29,-30,-30,-30,-31,-31,-31,-32,-32,-32,-33,-33,-33,-34,-34,-34,-34,-34,-34,-34,-34,-35,-35,-35,-35,-35,-35,-35,-35,-35,-34,-34,-34,-33,-33,-33,-32,-32,-31,-31,-30,-29,-29,-28,-28,-27,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,21,22,23,24,25,26,27,28,28,29,29,30,31,31,32,32,33,33,33,34,34,34,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,35,34,34,34,33,33,33,32,32,31,31,30,29,29,28,28,27,26,25,24,23,22,21,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-27,-28,-28,-29,-29,-30,-31,-31,-32,-32,-33,-33,-33,-34,-34,-34,-35,-35,-35,-35,-35,-35,-35,-35,-36,-36,-36,-36,-36,-36,-36,-36,-36,-35,-35,-35,-34,-34,-34,-33,-33,-32,-32,-31,-31,-30,-30,-29,-28,-28,-27,-27,-26,-26,-25,-25,-24,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,24,25,25,26,26,27,27,28,28,29,30,30,31,31,32,32,33,33,34,34,34,35,35,35,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,36,35,35,35,34,34,34,33,33,32,32,31,31,30,30,29,28,28,27,27,26,26,25,25,24,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-24,-25,-25,-26,-26,-27,-27,-28,-28,-29,-30,-30,-31,-31,-32,-32,-33,-33,-34,-34,-34,-35,-35,-35,-36,-36,-36,-36,-36,-36,-36,-36,-37,-37,-37,-37,-37,-37,-37,-37,-37,-36,-36,-36,-36,-35,-35,-35,-34,-34,-33,-33,-32,-32,-31,-30,-30,-29,-29,-28,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,12,13,14,15,16,17,18,19,20,21,22,23,23,24,25,26,27,28,29,29,30,30,31,32,32,33,33,34,34,35,35,35,36,36,36,36,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,37,36,36,36,36,35,35,35,34,34,33,33,32,32,31,30,30,29,29,28,27,26,25,24,23,23,22,21,20,19,18,17,16,15,14,13,12,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-28,-29,-29,-30,-30,-31,-32,-32,-33,-33,-34,-34,-35,-35,-35,-36,-36,-36,-36,-37,-37,-37,-37,-37,-37,-37,-37,-38,-38,-38,-38,-38,-38,-38,-38,-38,-37,-37,-37,-37,-36,-36,-35,-35,-35,-34,-34,-34,-33,-33,-32,-32,-31,-31,-30,-29,-29,-28,-28,-27,-27,-26,-26,-25,-24,-23,-22,-22,-21,-20,-19,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,19,20,21,22,22,23,24,25,26,26,27,27,28,28,29,29,30,31,31,32,32,33,33,34,34,34,35,35,35,36,36,37,37,37,37,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,38,37,37,37,37,36,36,35,35,35,34,34,34,33,33,32,32,31,31,30,29,29,28,28,27,27,26,26,25,24,23,22,22,21,20,19,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-19,-20,-21,-22,-22,-23,-24,-25,-26,-26,-27,-27,-28,-28,-29,-29,-30,-31,-31,-32,-32,-33,-33,-34,-34,-34,-35,-35,-35,-36,-36,-37,-37,-37,-37,-38,-38,-38,-38,-38,-38,-38,-38,-39,-39,-39,-39,-39,-39,-39,-39,-39,-38,-38,-38,-38,-37,-37,-37,-36,-36,-36,-35,-35,-34,-34,-33,-33,-32,-31,-31,-30,-30,-29,-28,-27,-26,-25,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,19,20,21,21,22,23,24,25,25,26,27,28,29,30,30,31,31,32,33,33,34,34,35,35,36,36,36,37,37,37,38,38,38,38,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,39,38,38,38,38,37,37,37,36,36,36,35,35,34,34,33,33,32,31,31,30,30,29,28,27,26,25,25,24,23,22,21,21,20,19,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-25,-26,-27,-28,-29,-30,-30,-31,-31,-32,-33,-33,-34,-34,-35,-35,-36,-36,-36,-37,-37,-37,-38,-38,-38,-38,-39,-39,-39,-39,-39,-39,-39,-39,-40,-40,-40,-40,-40,-40,-40,-40,-40,-39,-39,-39,-39,-38,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-33,-32,-32,-31,-30,-29,-28,-27,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,24,25,26,27,28,29,30,31,32,32,33,33,34,35,35,36,36,37,37,38,38,38,39,39,39,39,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,40,39,39,39,39,38,38,38,37,37,36,36,35,35,34,33,33,32,32,31,30,29,28,27,26,25,24,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-27,-28,-29,-30,-31,-32,-32,-33,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-38,-39,-39,-39,-39,-40,-40,-40,-40,-40,-40,-40,-40,-41,-41,-41,-41,-41,-41,-41,-41,-41,-41,-40,-40,-40,-40,-39,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-32,-32,-31,-31,-30,-30,-29,-29,-28,-28,-27,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,23,24,25,26,27,27,28,28,29,29,30,30,31,31,32,32,33,34,34,35,35,36,36,37,37,38,38,39,39,39,40,40,40,40,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,41,40,40,40,40,39,39,39,38,38,37,37,36,36,35,35,34,34,33,32,32,31,31,30,30,29,29,28,28,27,27,26,25,24,23,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-27,-28,-28,-29,-29,-30,-30,-31,-31,-32,-32,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-39,-40,-40,-40,-40,-41,-41,-41,-41,-41,-41,-41,-41,-41,-42,-42,-42,-42,-42,-42,-42,-42,-42,-42,-41,-41,-41,-40,-40,-40,-39,-39,-39,-38,-38,-38,-37,-37,-36,-36,-35,-34,-34,-33,-33,-32,-31,-30,-29,-28,-27,-26,-26,-25,-24,-23,-22,-21,-20,-20,-19,-18,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,18,19,20,20,21,22,23,24,25,26,26,27,28,29,30,31,32,33,33,34,34,35,36,36,37,37,38,38,38,39,39,39,40,40,40,41,41,41,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,42,41,41,41,40,40,40,39,39,39,38,38,38,37,37,36,36,35,34,34,33,33,32,31,30,29,28,27,26,26,25,24,23,22,21,20,20,19,18,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-18,-19,-20,-20,-21,-22,-23,-24,-25,-26,-26,-27,-28,-29,-30,-31,-32,-33,-33,-34,-34,-35,-36,-36,-37,-37,-38,-38,-38,-39,-39,-39,-40,-40,-40,-41,-41,-41,-42,-42,-42,-42,-42,-42,-42,-42,-42,-43,-43,-43,-43,-43,-43,-43,-43,-43,-43,-42,-42,-42,-42,-41,-41,-41,-40,-40,-40,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-33,-32,-32,-31,-31,-30,-30,-29,-29,-28,-27,-26,-25,-25,-24,-23,-22,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,13,14,15,16,17,18,19,20,21,22,22,23,24,25,25,26,27,28,29,29,30,30,31,31,32,32,33,33,34,35,35,36,36,37,37,38,38,39,39,40,40,40,41,41,41,42,42,42,42,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,43,42,42,42,42,41,41,41,40,40,40,39,39,38,38,37,37,36,36,35,35,34,33,33,32,32,31,31,30,30,29,29,28,27,26,25,25,24,23,22,22,21,20,19,18,17,16,15,14,13,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-22,-23,-24,-25,-25,-26,-27,-28,-29,-29,-30,-30,-31,-31,-32,-32,-33,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-40,-40,-40,-41,-41,-41,-42,-42,-42,-42,-43,-43,-43,-43,-43,-43,-43,-43,-43,-44,-44,-44,-44,-44,-44,-44,-44,-44,-44,-43,-43,-43,-43,-42,-42,-42,-41,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-35,-35,-34,-34,-33,-32,-31,-30,-29,-28,-28,-27,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16,17,18,19,20,21,22,23,24,24,25,26,27,28,28,29,30,31,32,33,34,34,35,35,36,37,37,38,38,39,39,40,40,41,41,41,42,42,42,43,43,43,43,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,43,43,43,43,42,42,42,41,41,41,40,40,39,39,38,38,37,37,36,35,35,34,34,33,32,31,30,29,28,28,27,26,25,24,24,23,22,21,20,19,18,17,16,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-27,-28,-28,-29,-30,-31,-32,-33,-34,-34,-35,-35,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-41,-42,-42,-42,-43,-43,-43,-43,-44,-44,-44,-44,-44,-44,-44,-44,-44,-45,-45,-45,-45,-45,-45,-45,-45,-45,-45,-44,-44,-44,-44,-43,-43,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-37,-37,-36,-36,-35,-34,-33,-33,-32,-32,-31,-30,-29,-28,-27,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,27,28,29,30,31,32,32,33,33,34,35,36,36,37,37,38,39,39,40,40,41,41,42,42,43,43,43,44,44,44,44,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,45,44,44,44,44,43,43,43,42,42,41,41,40,40,39,39,38,37,37,36,36,35,34,33,33,32,32,31,30,29,28,27,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-27,-28,-29,-30,-31,-32,-32,-33,-33,-34,-35,-36,-36,-37,-37,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-43,-43,-44,-44,-44,-44,-45,-45,-45,-45,-45,-45,-45,-45,-45,-46,-46,-46,-46,-46,-46,-46,-46,-46,-46,-45,-45,-45,-45,-44,-44,-44,-43,-43,-42,-42,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-36,-36,-35,-35,-34,-34,-33,-32,-31,-31,-30,-30,-29,-28,-27,-26,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,21,22,23,24,25,26,26,27,28,29,30,30,31,31,32,33,34,34,35,35,36,36,37,38,38,39,39,40,40,41,41,42,42,42,43,43,44,44,44,45,45,45,45,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,46,45,45,45,45,44,44,44,43,43,42,42,42,41,41,40,40,39,39,38,38,37,36,36,35,35,34,34,33,32,31,31,30,30,29,28,27,26,26,25,24,23,22,21,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-26,-27,-28,-29,-30,-30,-31,-31,-32,-33,-34,-34,-35,-35,-36,-36,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-42,-42,-43,-43,-44,-44,-44,-45,-45,-45,-45,-46,-46,-46,-46,-46,-46,-46,-46,-46,-47,-47,-47,-47,-47,-47,-47,-47,-47,-47,-46,-46,-46,-46,-45,-45,-45,-44,-44,-44,-43,-43,-43,-42,-42,-41,-41,-40,-40,-39,-38,-38,-37,-37,-36,-35,-34,-33,-32,-31,-30,-29,-29,-28,-27,-26,-25,-24,-23,-23,-22,-21,-20,-19,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,19,20,21,22,23,23,24,25,26,27,28,29,29,30,31,32,33,34,35,36,37,37,38,38,39,40,40,41,41,42,42,43,43,43,44,44,44,45,45,45,46,46,46,46,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,47,46,46,46,46,45,45,45,44,44,44,43,43,43,42,42,41,41,40,40,39,38,38,37,37,36,35,34,33,32,31,30,29,29,28,27,26,25,24,23,23,22,21,20,19,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-19,-20,-21,-22,-23,-23,-24,-25,-26,-27,-28,-29,-29,-30,-31,-32,-33,-34,-35,-36,-37,-37,-38,-38,-39,-40,-40,-41,-41,-42,-42,-43,-43,-43,-44,-44,-44,-45,-45,-45,-46,-46,-46,-46,-47,-47,-47,-47,-47,-47,-47,-47,-47,-48,-48,-48,-48,-48,-48,-48,-48,-48,-48,-47,-47,-47,-47,-46,-46,-46,-45,-45,-45,-44,-44,-43,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-33,-32,-32,-31,-30,-29,-28,-28,-27,-26,-25,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,25,26,27,28,28,29,30,31,32,32,33,33,34,34,35,35,36,36,37,37,38,39,39,40,40,41,41,42,42,43,43,44,44,45,45,45,46,46,46,47,47,47,47,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,48,47,47,47,47,46,46,46,45,45,45,44,44,43,43,42,42,41,41,40,40,39,39,38,37,37,36,36,35,35,34,34,33,33,32,32,31,30,29,28,28,27,26,25,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-25,-26,-27,-28,-28,-29,-30,-31,-32,-32,-33,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-43,-44,-44,-45,-45,-45,-46,-46,-46,-47,-47,-47,-47,-48,-48,-48,-48,-48,-48,-48,-48,-48,-49,-49,-49,-49,-49,-49,-49,-49,-49,-49,-48,-48,-48,-48,-47,-47,-47,-47,-46,-46,-46,-45,-45,-44,-44,-43,-43,-42,-42,-41,-41,-40,-39,-39,-38,-38,-37,-36,-35,-34,-33,-32,-31,-31,-30,-29,-28,-27,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,17,18,19,20,21,22,23,24,25,26,27,27,28,29,30,31,31,32,33,34,35,36,37,38,38,39,39,40,41,41,42,42,43,43,44,44,45,45,46,46,46,47,47,47,47,48,48,48,48,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,49,48,48,48,48,47,47,47,47,46,46,46,45,45,44,44,43,43,42,42,41,41,40,39,39,38,38,37,36,35,34,33,32,31,31,30,29,28,27,27,26,25,24,23,22,21,20,19,18,17,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-27,-28,-29,-30,-31,-31,-32,-33,-34,-35,-36,-37,-38,-38,-39,-39,-40,-41,-41,-42,-42,-43,-43,-44,-44,-45,-45,-46,-46,-46,-47,-47,-47,-47,-48,-48,-48,-48,-49,-49,-49,-49,-49,-49,-49,-49,-49,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-49,-49,-49,-49,-49,-48,-48,-48,-48,-47,-47,-46,-46,-46,-45,-45,-44,-44,-43,-43,-42,-41,-41,-40,-40,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-34,-33,-32,-31,-30,-30,-29,-28,-27,-26,-25,-24,-23,-22,-22,-21,-20,-19,-18,-17,-16,-15,-14,-14,-13,-12,-11,-10,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,10,11,12,13,14,14,15,16,17,18,19,20,21,22,22,23,24,25,26,27,28,29,30,30,31,32,33,34,34,35,35,36,36,37,37,38,38,39,40,40,41,41,42,43,43,44,44,45,45,46,46,46,47,47,48,48,48,48,49,49,49,49,49,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,50,49,49,49,49,49,48,48,48,48,47,47,46,46,46,45,45,44,44,43,43,42,41,41,40,40,39,38,38,37,37,36,36,35,35,34,34,33,32,31,30,30,29,28,27,26,25,24,23,22,22,21,20,19,18,17,16,15,14,14,13,12,11,10,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-10,-11,-12,-13,-14,-14,-15,-16,-17,-18,-19,-20,-21,-22,-22,-23,-24,-25,-26,-27,-28,-29,-30,-30,-31,-32,-33,-34,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-40,-40,-41,-41,-42,-43,-43,-44,-44,-45,-45,-46,-46,-46,-47,-47,-48,-48,-48,-48,-49,-49,-49,-49,-49,-50,-50,-50,-50,-50,-50,-50,-50,-50,-50,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-50,-50,-50,-50,-49,-49,-49,-48,-48,-47,-47,-47,-46,-46,-45,-45,-45,-44,-44,-43,-43,-42,-42,-41,-40,-40,-39,-39,-38,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-29,-28,-27,-26,-26,-25,-24,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,24,25,26,26,27,28,29,29,30,31,32,33,33,34,35,36,37,38,39,39,40,40,41,42,42,43,43,44,44,45,45,45,46,46,47,47,47,48,48,49,49,49,50,50,50,50,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,51,50,50,50,50,49,49,49,48,48,47,47,47,46,46,45,45,45,44,44,43,43,42,42,41,40,40,39,39,38,37,36,35,34,33,33,32,31,30,29,29,28,27,26,26,25,24,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-24,-25,-26,-26,-27,-28,-29,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-38,-39,-39,-40,-40,-41,-42,-42,-43,-43,-44,-44,-45,-45,-45,-46,-46,-47,-47,-47,-48,-48,-49,-49,-49,-50,-50,-50,-50,-51,-51,-51,-51,-51,-51,-51,-51,-51,-51,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-51,-51,-51,-51,-50,-50,-50,-49,-49,-49,-48,-48,-48,-47,-47,-46,-46,-45,-44,-44,-43,-42,-42,-41,-41,-40,-39,-38,-37,-36,-35,-34,-33,-32,-32,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,21,22,23,24,25,26,27,28,29,30,31,32,32,33,34,35,36,37,38,39,40,41,41,42,42,43,44,44,45,46,46,47,47,48,48,48,49,49,49,50,50,50,51,51,51,51,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,52,51,51,51,51,50,50,50,49,49,49,48,48,48,47,47,46,46,45,44,44,43,42,42,41,41,40,39,38,37,36,35,34,33,32,32,31,30,29,28,27,26,25,24,23,22,21,20,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-32,-32,-33,-34,-35,-36,-37,-38,-39,-40,-41,-41,-42,-42,-43,-44,-44,-45,-46,-46,-47,-47,-48,-48,-48,-49,-49,-49,-50,-50,-50,-51,-51,-51,-51,-52,-52,-52,-52,-52,-52,-52,-52,-52,-52,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-52,-52,-52,-52,-51,-51,-51,-50,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-45,-44,-44,-43,-43,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-36,-35,-35,-34,-33,-32,-31,-31,-30,-29,-28,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,28,29,30,31,31,32,33,34,35,35,36,36,37,37,38,38,39,39,40,40,41,41,42,43,43,44,44,45,45,46,46,47,47,48,48,49,49,50,50,50,51,51,51,52,52,52,52,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,53,52,52,52,52,51,51,51,50,50,50,49,49,48,48,47,47,46,46,45,45,44,44,43,43,42,41,41,40,40,39,39,38,38,37,37,36,36,35,35,34,33,32,31,31,30,29,28,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-28,-29,-30,-31,-31,-32,-33,-34,-35,-35,-36,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-43,-43,-44,-44,-45,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-50,-51,-51,-51,-52,-52,-52,-52,-53,-53,-53,-53,-53,-53,-53,-53,-53,-53,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-53,-53,-53,-53,-52,-52,-52,-51,-51,-51,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-45,-44,-43,-43,-42,-42,-41,-40,-39,-38,-37,-36,-35,-34,-34,-33,-32,-31,-30,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,30,31,32,33,34,34,35,36,37,38,39,40,41,42,42,43,43,44,45,45,46,46,47,47,48,48,49,49,50,50,51,51,51,52,52,52,53,53,53,53,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,54,53,53,53,53,52,52,52,51,51,51,50,50,49,49,48,48,47,47,46,46,45,45,44,43,43,42,42,41,40,39,38,37,36,35,34,34,33,32,31,30,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-30,-31,-32,-33,-34,-34,-35,-36,-37,-38,-39,-40,-41,-42,-42,-43,-43,-44,-45,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-51,-51,-51,-52,-52,-52,-53,-53,-53,-53,-54,-54,-54,-54,-54,-54,-54,-54,-54,-54,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-54,-54,-54,-54,-53,-53,-53,-53,-52,-52,-52,-51,-51,-51,-50,-50,-50,-49,-49,-49,-48,-48,-47,-47,-46,-45,-45,-44,-44,-43,-42,-42,-41,-41,-40,-40,-39,-39,-38,-38,-37,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-28,-27,-27,-26,-25,-25,-24,-23,-23,-22,-21,-20,-19,-18,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,18,19,20,21,22,23,23,24,25,25,26,27,27,28,29,30,31,32,33,33,34,35,36,37,37,38,38,39,39,40,40,41,41,42,42,43,44,44,45,45,46,47,47,48,48,49,49,49,50,50,50,51,51,51,52,52,52,53,53,53,53,54,54,54,54,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,55,54,54,54,54,53,53,53,53,52,52,52,51,51,51,50,50,50,49,49,49,48,48,47,47,46,45,45,44,44,43,42,42,41,41,40,40,39,39,38,38,37,37,36,35,34,33,33,32,31,30,29,28,27,27,26,25,25,24,23,23,22,21,20,19,18,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-18,-19,-20,-21,-22,-23,-23,-24,-25,-25,-26,-27,-27,-28,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-37,-38,-38,-39,-39,-40,-40,-41,-41,-42,-42,-43,-44,-44,-45,-45,-46,-47,-47,-48,-48,-49,-49,-49,-50,-50,-50,-51,-51,-51,-52,-52,-52,-53,-53,-53,-53,-54,-54,-54,-54,-55,-55,-55,-55,-55,-55,-55,-55,-55,-55,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-55,-55,-55,-55,-54,-54,-54,-54,-53,-53,-52,-52,-52,-51,-51,-50,-50,-49,-49,-48,-48,-47,-47,-46,-46,-45,-44,-44,-43,-43,-42,-41,-40,-39,-38,-37,-36,-36,-35,-34,-33,-32,-32,-31,-30,-29,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,29,30,31,32,32,33,34,35,36,36,37,38,39,40,41,42,43,43,44,44,45,46,46,47,47,48,48,49,49,50,50,51,51,52,52,52,53,53,54,54,54,54,55,55,55,55,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,55,55,55,55,54,54,54,54,53,53,52,52,52,51,51,50,50,49,49,48,48,47,47,46,46,45,44,44,43,43,42,41,40,39,38,37,36,36,35,34,33,32,32,31,30,29,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-29,-30,-31,-32,-32,-33,-34,-35,-36,-36,-37,-38,-39,-40,-41,-42,-43,-43,-44,-44,-45,-46,-46,-47,-47,-48,-48,-49,-49,-50,-50,-51,-51,-52,-52,-52,-53,-53,-54,-54,-54,-54,-55,-55,-55,-55,-56,-56,-56,-56,-56,-56,-56,-56,-56,-56,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-56,-56,-56,-56,-56,-55,-55,-55,-55,-54,-54,-54,-53,-53,-53,-52,-52,-51,-51,-50,-50,-49,-49,-48,-48,-47,-46,-46,-45,-45,-44,-43,-42,-41,-41,-40,-39,-38,-37,-36,-35,-35,-34,-33,-32,-31,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-21,-20,-19,-18,-17,-16,-15,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,15,16,17,18,19,20,21,21,22,23,24,25,26,27,28,29,30,31,31,32,33,34,35,35,36,37,38,39,40,41,41,42,43,44,45,45,46,46,47,48,48,49,49,50,50,51,51,52,52,53,53,53,54,54,54,55,55,55,55,56,56,56,56,56,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,57,56,56,56,56,56,55,55,55,55,54,54,54,53,53,53,52,52,51,51,50,50,49,49,48,48,47,46,46,45,45,44,43,42,41,41,40,39,38,37,36,35,35,34,33,32,31,31,30,29,28,27,26,25,24,23,22,21,21,20,19,18,17,16,15,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-15,-16,-17,-18,-19,-20,-21,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-31,-32,-33,-34,-35,-35,-36,-37,-38,-39,-40,-41,-41,-42,-43,-44,-45,-45,-46,-46,-47,-48,-48,-49,-49,-50,-50,-51,-51,-52,-52,-53,-53,-53,-54,-54,-54,-55,-55,-55,-55,-56,-56,-56,-56,-56,-57,-57,-57,-57,-57,-57,-57,-57,-57,-57,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-57,-57,-57,-57,-57,-56,-56,-56,-55,-55,-55,-54,-54,-53,-53,-52,-52,-51,-51,-50,-50,-49,-48,-48,-47,-47,-46,-45,-45,-44,-44,-43,-43,-42,-42,-41,-40,-40,-39,-39,-38,-38,-37,-36,-35,-34,-34,-33,-32,-31,-30,-29,-28,-27,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,34,35,36,37,38,38,39,39,40,40,41,42,42,43,43,44,44,45,45,46,47,47,48,48,49,50,50,51,51,52,52,53,53,54,54,55,55,55,56,56,56,57,57,57,57,57,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,58,57,57,57,57,57,56,56,56,55,55,55,54,54,53,53,52,52,51,51,50,50,49,48,48,47,47,46,45,45,44,44,43,43,42,42,41,40,40,39,39,38,38,37,36,35,34,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-27,-28,-29,-30,-31,-32,-33,-34,-34,-35,-36,-37,-38,-38,-39,-39,-40,-40,-41,-42,-42,-43,-43,-44,-44,-45,-45,-46,-47,-47,-48,-48,-49,-50,-50,-51,-51,-52,-52,-53,-53,-54,-54,-55,-55,-55,-56,-56,-56,-57,-57,-57,-57,-57,-58,-58,-58,-58,-58,-58,-58,-58,-58,-58,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59,-58,-58,-58,-58,-58,-57,-57,-57,-56,-56,-56,-55,-55,-54,-54,-54,-53,-53,-53,-52,-52,-51,-51,-50,-50,-49,-49,-48,-47,-47,-46,-46,-45,-44,-43,-42,-41,-40,-39,-38,-37,-37,-36,-35,-34,-33,-33,-32,-31,-30,-29,-28,-28,-27,-26,-26,-25,-24,-23,-22,-21,-20,-19,-18,-17,-16,-15,-14,-13,-12,-11,-10,-9,-8,-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,26,27,28,28,29,30,31,32,33,33,34,35,36,37,37,38,39,40,41,42,43,44,45,46,46,47,47,48,49,49,50,50,51,51,52,52,53,53,53,54,54,54,55,55,56,56,56,57,57,57,58,58,58,58,58,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,59,58,58,58,58,58,57,57,57,56,56,56,55,55,54,54,54,53,53,53,52,52,51,51,50,50,49,49,48,47,47,46,46,45,44,43,42,41,40,39,38,37,37,36,35,34,33,33,32,31,30,29,28,28,27,26,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-11,-12,-13,-14,-15,-16,-17,-18,-19,-20,-21,-22,-23,-24,-25,-26,-26,-27,-28,-28,-29,-30,-31,-32,-33,-33,-34,-35,-36,-37,-37,-38,-39,-40,-41,-42,-43,-44,-45,-46,-46,-47,-47,-48,-49,-49,-50,-50,-51,-51,-52,-52,-53,-53,-53,-54,-54,-54,-55,-55,-56,-56,-56,-57,-57,-57,-58,-58,-58,-58,-58,-59,-59,-59,-59,-59,-59,-59,-59,-59,-59];
var towards_center = [0,0,0,0,0,0,0,0,0,1,1,2,3,3,3,4,5,5,5,6,7,7,7,8,1,9,9,10,12,13,13,13,14,16,17,17,17,18,20,21,21,21,22,24,9,25,25,26,11,29,30,30,30,31,15,34,35,35,35,36,19,39,40,40,40,41,23,44,25,45,45,46,47,27,48,28,49,50,51,51,51,52,53,32,54,33,55,56,57,57,57,58,59,37,60,38,61,62,63,63,63,64,65,42,66,43,67,68,45,69,69,70,71,73,75,77,78,79,79,79,80,81,83,85,87,88,89,89,89,90,91,93,95,97,98,99,99,99,100,101,103,105,107,108,69,109,109,110,111,72,113,74,114,76,116,117,118,118,118,119,120,82,122,84,123,86,125,126,127,127,127,128,129,92,131,94,132,96,134,135,136,136,136,137,138,102,140,104,141,106,143,144,109,145,145,146,147,148,112,149,151,153,115,154,155,156,157,157,157,158,159,160,121,161,163,165,124,166,167,168,169,169,169,170,171,172,130,173,175,177,133,178,179,180,181,181,181,182,183,184,139,185,187,189,142,190,191,192,145,193,193,194,195,196,198,150,200,152,202,204,205,206,207,207,207,208,209,210,212,162,214,164,216,218,219,220,221,221,221,222,223,224,226,174,228,176,230,232,233,234,235,235,235,236,237,238,240,186,242,188,244,246,247,248,193,249,249,250,251,252,197,254,199,255,257,201,258,203,260,261,262,263,263,263,264,265,266,211,268,213,269,271,215,272,217,274,275,276,277,277,277,278,279,280,225,282,227,283,285,229,286,231,288,289,290,291,291,291,292,293,294,239,296,241,297,299,243,300,245,302,303,304,249,305,305,306,307,308,253,310,312,256,315,317,259,319,320,321,322,322,322,323,324,325,267,327,329,270,332,334,273,336,337,338,339,339,339,340,341,342,281,344,346,284,349,351,287,353,354,355,356,356,356,357,358,359,295,361,363,298,366,368,301,370,371,372,305,373,373,374,375,376,309,378,311,380,313,381,314,382,316,384,318,386,387,388,389,389,389,390,391,392,326,394,328,396,330,397,331,398,333,400,335,402,403,404,405,405,405,406,407,408,343,410,345,412,347,413,348,414,350,416,352,418,419,420,421,421,421,422,423,424,360,426,362,428,364,429,365,430,367,432,369,434,435,436,373,437,437,438,439,440,441,377,442,443,379,444,446,448,450,383,451,452,385,453,454,455,456,457,457,457,458,459,460,461,393,462,463,395,464,466,468,470,399,471,472,401,473,474,475,476,477,477,477,478,479,480,481,409,482,483,411,484,486,488,490,415,491,492,417,493,494,495,496,497,497,497,498,499,500,501,425,502,503,427,504,506,508,510,431,511,512,433,513,514,515,516,437,517,517,518,519,520,521,523,524,526,445,528,447,529,449,531,533,534,536,537,538,539,540,540,540,541,542,543,544,546,547,549,465,551,467,552,469,554,556,557,559,560,561,562,563,563,563,564,565,566,567,569,570,572,485,574,487,575,489,577,579,580,582,583,584,585,586,586,586,587,588,589,590,592,593,595,505,597,507,598,509,600,602,603,605,606,607,608,517,609,609,610,611,612,613,522,615,525,617,527,618,620,622,530,623,532,625,535,627,628,629,630,631,631,631,632,633,634,635,545,637,548,639,550,640,642,644,553,645,555,647,558,649,650,651,652,653,653,653,654,655,656,657,568,659,571,661,573,662,664,666,576,667,578,669,581,671,672,673,674,675,675,675,676,677,678,679,591,681,594,683,596,684,686,688,599,689,601,691,604,693,694,695,696,609,697,697,698,699,700,701,614,703,616,705,707,619,709,621,711,713,624,715,626,717,718,719,720,721,721,721,722,723,724,725,636,727,638,729,731,641,733,643,735,737,646,739,648,741,742,743,744,745,745,745,746,747,748,749,658,751,660,753,755,663,757,665,759,761,668,763,670,765,766,767,768,769,769,769,770,771,772,773,680,775,682,777,779,685,781,687,783,785,690,787,692,789,790,791,792,697,793,793,794,795,796,797,702,799,800,704,801,706,803,708,804,806,710,807,712,809,714,810,811,716,813,814,815,816,817,817,817,818,819,820,821,726,823,824,728,825,730,827,732,828,830,734,831,736,833,738,834,835,740,837,838,839,840,841,841,841,842,843,844,845,750,847,848,752,849,754,851,756,852,854,758,855,760,857,762,858,859,764,861,862,863,864,865,865,865,866,867,868,869,774,871,872,776,873,778,875,780,876,878,782,879,784,881,786,882,883,788,885,886,887,888,793,889,889,890,891,892,893,894,798,895,896,898,899,802,900,902,805,905,907,808,908,909,911,912,812,913,914,915,916,917,918,918,918,919,920,921,922,923,822,924,925,927,928,826,929,931,829,934,936,832,937,938,940,941,836,942,943,944,945,946,947,947,947,948,949,950,951,952,846,953,954,956,957,850,958,960,853,963,965,856,966,967,969,970,860,971,972,973,974,975,976,976,976,977,978,979,980,981,870,982,983,985,986,874,987,989,877,992,994,880,995,996,998,999,884,1000,1001,1002,1003,1004,889,1005,1005,1006,1007,1008,1009,1010,1012,1013,897,1015,1017,901,1019,903,1020,904,1021,906,1023,1025,910,1027,1028,1030,1031,1032,1033,1034,1035,1035,1035,1036,1037,1038,1039,1040,1042,1043,926,1045,1047,930,1049,932,1050,933,1051,935,1053,1055,939,1057,1058,1060,1061,1062,1063,1064,1065,1065,1065,1066,1067,1068,1069,1070,1072,1073,955,1075,1077,959,1079,961,1080,962,1081,964,1083,1085,968,1087,1088,1090,1091,1092,1093,1094,1095,1095,1095,1096,1097,1098,1099,1100,1102,1103,984,1105,1107,988,1109,990,1110,991,1111,993,1113,1115,997,1117,1118,1120,1121,1122,1123,1124,1005,1125,1125,1126,1127,1128,1129,1130,1011,1132,1014,1134,1016,1136,1018,1137,1139,1141,1143,1022,1144,1024,1146,1026,1148,1029,1150,1151,1152,1153,1154,1155,1155,1155,1156,1157,1158,1159,1160,1041,1162,1044,1164,1046,1166,1048,1167,1169,1171,1173,1052,1174,1054,1176,1056,1178,1059,1180,1181,1182,1183,1184,1185,1185,1185,1186,1187,1188,1189,1190,1071,1192,1074,1194,1076,1196,1078,1197,1199,1201,1203,1082,1204,1084,1206,1086,1208,1089,1210,1211,1212,1213,1214,1215,1215,1215,1216,1217,1218,1219,1220,1101,1222,1104,1224,1106,1226,1108,1227,1229,1231,1233,1112,1234,1114,1236,1116,1238,1119,1240,1241,1242,1243,1244,1125,1245,1245,1246,1247,1248,1249,1250,1131,1252,1253,1133,1254,1255,1135,1256,1258,1138,1260,1140,1261,1142,1263,1265,1145,1266,1267,1147,1268,1269,1149,1271,1272,1273,1274,1275,1276,1276,1276,1277,1278,1279,1280,1281,1161,1283,1284,1163,1285,1286,1165,1287,1289,1168,1291,1170,1292,1172,1294,1296,1175,1297,1298,1177,1299,1300,1179,1302,1303,1304,1305,1306,1307,1307,1307,1308,1309,1310,1311,1312,1191,1314,1315,1193,1316,1317,1195,1318,1320,1198,1322,1200,1323,1202,1325,1327,1205,1328,1329,1207,1330,1331,1209,1333,1334,1335,1336,1337,1338,1338,1338,1339,1340,1341,1342,1343,1221,1345,1346,1223,1347,1348,1225,1349,1351,1228,1353,1230,1354,1232,1356,1358,1235,1359,1360,1237,1361,1362,1239,1364,1365,1366,1367,1368,1245,1369,1369,1370,1371,1372,1373,1374,1251,1376,1377,1379,1380,1382,1257,1384,1259,1385,1387,1389,1262,1390,1264,1392,1394,1395,1397,1398,1270,1400,1401,1402,1403,1404,1405,1405,1405,1406,1407,1408,1409,1410,1282,1412,1413,1415,1416,1418,1288,1420,1290,1421,1423,1425,1293,1426,1295,1428,1430,1431,1433,1434,1301,1436,1437,1438,1439,1440,1441,1441,1441,1442,1443,1444,1445,1446,1313,1448,1449,1451,1452,1454,1319,1456,1321,1457,1459,1461,1324,1462,1326,1464,1466,1467,1469,1470,1332,1472,1473,1474,1475,1476,1477,1477,1477,1478,1479,1480,1481,1482,1344,1484,1485,1487,1488,1490,1350,1492,1352,1493,1495,1497,1355,1498,1357,1500,1502,1503,1505,1506,1363,1508,1509,1510,1511,1512,1369,1513,1513,1514,1515,1516,1517,1518,1375,1520,1521,1378,1523,1381,1525,1383,1526,1528,1386,1388,1532,1534,1391,1535,1393,1537,1396,1539,1540,1399,1542,1543,1544,1545,1546,1547,1547,1547,1548,1549,1550,1551,1552,1411,1554,1555,1414,1557,1417,1559,1419,1560,1562,1422,1424,1566,1568,1427,1569,1429,1571,1432,1573,1574,1435,1576,1577,1578,1579,1580,1581,1581,1581,1582,1583,1584,1585,1586,1447,1588,1589,1450,1591,1453,1593,1455,1594,1596,1458,1460,1600,1602,1463,1603,1465,1605,1468,1607,1608,1471,1610,1611,1612,1613,1614,1615,1615,1615,1616,1617,1618,1619,1620,1483,1622,1623,1486,1625,1489,1627,1491,1628,1630,1494,1496,1634,1636,1499,1637,1501,1639,1504,1641,1642,1507,1644,1645,1646,1647,1648,1513,1649,1649,1650,1651,1652,1653,1654,1519,1656,1657,1522,1659,1524,1661,1663,1527,1665,1529,1666,1530,1667,1531,1668,1533,1670,1672,1536,1674,1538,1676,1677,1541,1679,1680,1681,1682,1683,1684,1684,1684,1685,1686,1687,1688,1689,1553,1691,1692,1556,1694,1558,1696,1698,1561,1700,1563,1701,1564,1702,1565,1703,1567,1705,1707,1570,1709,1572,1711,1712,1575,1714,1715,1716,1717,1718,1719,1719,1719,1720,1721,1722,1723,1724,1587,1726,1727,1590,1729,1592,1731,1733,1595,1735,1597,1736,1598,1737,1599,1738,1601,1740,1742,1604,1744,1606,1746,1747,1609,1749,1750,1751,1752,1753,1754,1754,1754,1755,1756,1757,1758,1759,1621,1761,1762,1624,1764,1626,1766,1768,1629,1770,1631,1771,1632,1772,1633,1773,1635,1775,1777,1638,1779,1640,1781,1782,1643,1784,1785,1786,1787,1788,1649,1789,1789,1790,1791,1792,1793,1794,1795,1655,1796,1797,1658,1799,1800,1660,1801,1662,1803,1664,1804,1806,1808,1810,1812,1669,1813,1671,1815,1673,1816,1817,1675,1819,1820,1678,1821,1822,1823,1824,1825,1826,1827,1827,1827,1828,1829,1830,1831,1832,1833,1690,1834,1835,1693,1837,1838,1695,1839,1697,1841,1699,1842,1844,1846,1848,1850,1704,1851,1706,1853,1708,1854,1855,1710,1857,1858,1713,1859,1860,1861,1862,1863,1864,1865,1865,1865,1866,1867,1868,1869,1870,1871,1725,1872,1873,1728,1875,1876,1730,1877,1732,1879,1734,1880,1882,1884,1886,1888,1739,1889,1741,1891,1743,1892,1893,1745,1895,1896,1748,1897,1898,1899,1900,1901,1902,1903,1903,1903,1904,1905,1906,1907,1908,1909,1760,1910,1911,1763,1913,1914,1765,1915,1767,1917,1769,1918,1920,1922,1924,1926,1774,1927,1776,1929,1778,1930,1931,1780,1933,1934,1783,1935,1936,1937,1938,1939,1940,1789,1941,1941,1942,1943,1944,1945,1946,1947,1949,1950,1951,1798,1952,1953,1955,1956,1802,1957,1959,1805,1961,1807,1962,1809,1963,1811,1965,1967,1814,1968,1969,1971,1972,1818,1973,1974,1975,1977,1978,1979,1980,1981,1982,1983,1983,1983,1984,1985,1986,1987,1988,1989,1991,1992,1993,1836,1994,1995,1997,1998,1840,1999,2001,1843,2003,1845,2004,1847,2005,1849,2007,2009,1852,2010,2011,2013,2014,1856,2015,2016,2017,2019,2020,2021,2022,2023,2024,2025,2025,2025,2026,2027,2028,2029,2030,2031,2033,2034,2035,1874,2036,2037,2039,2040,1878,2041,2043,1881,2045,1883,2046,1885,2047,1887,2049,2051,1890,2052,2053,2055,2056,1894,2057,2058,2059,2061,2062,2063,2064,2065,2066,2067,2067,2067,2068,2069,2070,2071,2072,2073,2075,2076,2077,1912,2078,2079,2081,2082,1916,2083,2085,1919,2087,1921,2088,1923,2089,1925,2091,2093,1928,2094,2095,2097,2098,1932,2099,2100,2101,2103,2104,2105,2106,2107,2108,1941,2109,2109,2110,2111,2112,2113,2114,2115,1948,2117,2118,2120,2121,1954,2123,2125,1958,2127,1960,2128,2130,2132,2134,1964,2135,1966,2137,2139,1970,2141,2142,2144,2145,1976,2147,2148,2149,2150,2151,2152,2153,2153,2153,2154,2155,2156,2157,2158,2159,1990,2161,2162,2164,2165,1996,2167,2169,2000,2171,2002,2172,2174,2176,2178,2006,2179,2008,2181,2183,2012,2185,2186,2188,2189,2018,2191,2192,2193,2194,2195,2196,2197,2197,2197,2198,2199,2200,2201,2202,2203,2032,2205,2206,2208,2209,2038,2211,2213,2042,2215,2044,2216,2218,2220,2222,2048,2223,2050,2225,2227,2054,2229,2230,2232,2233,2060,2235,2236,2237,2238,2239,2240,2241,2241,2241,2242,2243,2244,2245,2246,2247,2074,2249,2250,2252,2253,2080,2255,2257,2084,2259,2086,2260,2262,2264,2266,2090,2267,2092,2269,2271,2096,2273,2274,2276,2277,2102,2279,2280,2281,2282,2283,2284,2109,2285,2285,2286,2287,2288,2289,2290,2291,2116,2293,2294,2119,2296,2122,2298,2124,2300,2126,2301,2303,2129,2131,2133,2308,2310,2136,2311,2138,2313,2140,2315,2143,2317,2318,2146,2320,2321,2322,2323,2324,2325,2326,2326,2326,2327,2328,2329,2330,2331,2332,2160,2334,2335,2163,2337,2166,2339,2168,2341,2170,2342,2344,2173,2175,2177,2349,2351,2180,2352,2182,2354,2184,2356,2187,2358,2359,2190,2361,2362,2363,2364,2365,2366,2367,2367,2367,2368,2369,2370,2371,2372,2373,2204,2375,2376,2207,2378,2210,2380,2212,2382,2214,2383,2385,2217,2219,2221,2390,2392,2224,2393,2226,2395,2228,2397,2231,2399,2400,2234,2402,2403,2404,2405,2406,2407,2408,2408,2408,2409,2410,2411,2412,2413,2414,2248,2416,2417,2251,2419,2254,2421,2256,2423,2258,2424,2426,2261,2263,2265,2431,2433,2268,2434,2270,2436,2272,2438,2275,2440,2441,2278,2443,2444,2445,2446,2447,2448,2285,2449,2449,2450,2451,2452,2453,2454,2455,2292,2457,2458,2295,2460,2461,2297,2462,2299,2464,2466,2302,2468,2304,2469,2305,2470,2306,2471,2307,2472,2309,2474,2476,2312,2478,2314,2479,2480,2316,2482,2483,2319,2485,2486,2487,2488,2489,2490,2491,2491,2491,2492,2493,2494,2495,2496,2497,2333,2499,2500,2336,2502,2503,2338,2504,2340,2506,2508,2343,2510,2345,2511,2346,2512,2347,2513,2348,2514,2350,2516,2518,2353,2520,2355,2521,2522,2357,2524,2525,2360,2527,2528,2529,2530,2531,2532,2533,2533,2533,2534,2535,2536,2537,2538,2539,2374,2541,2542,2377,2544,2545,2379,2546,2381,2548,2550,2384,2552,2386,2553,2387,2554,2388,2555,2389,2556,2391,2558,2560,2394,2562,2396,2563,2564,2398,2566,2567,2401,2569,2570,2571,2572,2573,2574,2575,2575,2575,2576,2577,2578,2579,2580,2581,2415,2583,2584,2418,2586,2587,2420,2588,2422,2590,2592,2425,2594,2427,2595,2428,2596,2429,2597,2430,2598,2432,2600,2602,2435,2604,2437,2605,2606,2439,2608,2609,2442,2611,2612,2613,2614,2615,2616,2449,2617,2617,2618,2619,2620,2621,2622,2623,2456,2625,2626,2459,2628,2629,2631,2632,2463,2633,2465,2635,2467,2636,2638,2640,2642,2644,2646,2473,2647,2475,2649,2477,2650,2651,2653,2654,2481,2656,2657,2484,2659,2660,2661,2662,2663,2664,2665,2665,2665,2666,2667,2668,2669,2670,2671,2498,2673,2674,2501,2676,2677,2679,2680,2505,2681,2507,2683,2509,2684,2686,2688,2690,2692,2694,2515,2695,2517,2697,2519,2698,2699,2701,2702,2523,2704,2705,2526,2707,2708,2709,2710,2711,2712,2713,2713,2713,2714,2715,2716,2717,2718,2719,2540,2721,2722,2543,2724,2725,2727,2728,2547,2729,2549,2731,2551,2732,2734,2736,2738,2740,2742,2557,2743,2559,2745,2561,2746,2747,2749,2750,2565,2752,2753,2568,2755,2756,2757,2758,2759,2760,2761,2761,2761,2762,2763,2764,2765,2766,2767,2582,2769,2770,2585,2772,2773,2775,2776,2589,2777,2591,2779,2593,2780,2782,2784,2786,2788,2790,2599,2791,2601,2793,2603,2794,2795,2797,2798,2607,2800,2801,2610,2803,2804,2805,2806,2807,2808,2617,2809,2809,2810,2811,2812,2813,2814,2815,2624,2817,2818,2819,2627,2820,2821,2630,2823,2825,2826,2634,2827,2829,2637,2831,2639,2832,2641,2833,2643,2834,2645,2836,2838,2648,2839,2840,2842,2652,2844,2845,2655,2846,2847,2848,2658,2850,2851,2852,2853,2854,2855,2856,2856,2856,2857,2858,2859,2860,2861,2862,2672,2864,2865,2866,2675,2867,2868,2678,2870,2872,2873,2682,2874,2876,2685,2878,2687,2879,2689,2880,2691,2881,2693,2883,2885,2696,2886,2887,2889,2700,2891,2892,2703,2893,2894,2895,2706,2897,2898,2899,2900,2901,2902,2903,2903,2903,2904,2905,2906,2907,2908,2909,2720,2911,2912,2913,2723,2914,2915,2726,2917,2919,2920,2730,2921,2923,2733,2925,2735,2926,2737,2927,2739,2928,2741,2930,2932,2744,2933,2934,2936,2748,2938,2939,2751,2940,2941,2942,2754,2944,2945,2946,2947,2948,2949,2950,2950,2950,2951,2952,2953,2954,2955,2956,2768,2958,2959,2960,2771,2961,2962,2774,2964,2966,2967,2778,2968,2970,2781,2972,2783,2973,2785,2974,2787,2975,2789,2977,2979,2792,2980,2981,2983,2796,2985,2986,2799,2987,2988,2989,2802,2991,2992,2993,2994,2995,2996,2809,2997,2997,2998,2999,3000,3001,3002,3003,3004,2816,3005,3006,3007,3009,3010,2822,3012,2824,3014,3016,2828,3018,2830,3019,3021,3023,3025,3027,2835,3028,2837,3030,3032,2841,3034,2843,3036,3037,3039,3040,3041,2849,3042,3043,3044,3045,3046,3047,3048,3049,3049,3049,3050,3051,3052,3053,3054,3055,3056,2863,3057,3058,3059,3061,3062,2869,3064,2871,3066,3068,2875,3070,2877,3071,3073,3075,3077,3079,2882,3080,2884,3082,3084,2888,3086,2890,3088,3089,3091,3092,3093,2896,3094,3095,3096,3097,3098,3099,3100,3101,3101,3101,3102,3103,3104,3105,3106,3107,3108,2910,3109,3110,3111,3113,3114,2916,3116,2918,3118,3120,2922,3122,2924,3123,3125,3127,3129,3131,2929,3132,2931,3134,3136,2935,3138,2937,3140,3141,3143,3144,3145,2943,3146,3147,3148,3149,3150,3151,3152,3153,3153,3153,3154,3155,3156,3157,3158,3159,3160,2957,3161,3162,3163,3165,3166,2963,3168,2965,3170,3172,2969,3174,2971,3175,3177,3179,3181,3183,2976,3184,2978,3186,3188,2982,3190,2984,3192,3193,3195,3196,3197,2990,3198,3199,3200,3201,3202,3203,3204,2997,3205,3205,3206,3207,3208,3209,3210,3211,3212,3214,3215,3216,3008,3218,3011,3220,3013,3222,3015,3224,3017,3225,3227,3020,3229,3022,3230,3024,3231,3026,3233,3235,3029,3236,3031,3238,3033,3240,3035,3242,3038,3244,3245,3246,3248,3249,3250,3251,3252,3253,3254,3255,3255,3255,3256,3257,3258,3259,3260,3261,3262,3264,3265,3266,3060,3268,3063,3270,3065,3272,3067,3274,3069,3275,3277,3072,3279,3074,3280,3076,3281,3078,3283,3285,3081,3286,3083,3288,3085,3290,3087,3292,3090,3294,3295,3296,3298,3299,3300,3301,3302,3303,3304,3305,3305,3305,3306,3307,3308,3309,3310,3311,3312,3314,3315,3316,3112,3318,3115,3320,3117,3322,3119,3324,3121,3325,3327,3124,3329,3126,3330,3128,3331,3130,3333,3335,3133,3336,3135,3338,3137,3340,3139,3342,3142,3344,3345,3346,3348,3349,3350,3351,3352,3353,3354,3355,3355,3355,3356,3357,3358,3359,3360,3361,3362,3364,3365,3366,3164,3368,3167,3370,3169,3372,3171,3374,3173,3375,3377,3176,3379,3178,3380,3180,3381,3182,3383,3385,3185,3386,3187,3388,3189,3390,3191,3392,3194,3394,3395,3396,3398,3399,3400,3401,3402,3403,3404,3205,3405,3405,3406,3407,3408,3409,3410,3411,3412,3213,3414,3415,3217,3417,3418,3219,3419,3420,3221,3421,3422,3223,3423,3425,3226,3427,3228,3428,3430,3432,3434,3232,3435,3234,3437,3439,3237,3440,3441,3239,3442,3443,3241,3444,3445,3243,3447,3448,3247,3450,3451,3452,3453,3454,3455,3456,3457,3457,3457,3458,3459,3460,3461,3462,3463,3464,3263,3466,3467,3267,3469,3470,3269,3471,3472,3271,3473,3474,3273,3475,3477,3276,3479,3278,3480,3482,3484,3486,3282,3487,3284,3489,3491,3287,3492,3493,3289,3494,3495,3291,3496,3497,3293,3499,3500,3297,3502,3503,3504,3505,3506,3507,3508,3509,3509,3509,3510,3511,3512,3513,3514,3515,3516,3313,3518,3519,3317,3521,3522,3319,3523,3524,3321,3525,3526,3323,3527,3529,3326,3531,3328,3532,3534,3536,3538,3332,3539,3334,3541,3543,3337,3544,3545,3339,3546,3547,3341,3548,3549,3343,3551,3552,3347,3554,3555,3556,3557,3558,3559,3560,3561,3561,3561,3562,3563,3564,3565,3566,3567,3568,3363,3570,3571,3367,3573,3574,3369,3575,3576,3371,3577,3578,3373,3579,3581,3376,3583,3378,3584,3586,3588,3590,3382,3591,3384,3593,3595,3387,3596,3597,3389,3598,3599,3391,3600,3601,3393,3603,3604,3397,3606,3607,3608,3609,3610,3611,3612,3405,3613,3613,3614,3615,3616,3617,3618,3619,3620,3413,3622,3623,3416,3625,3626,3628,3629,3631,3632,3634,3424,3636,3426,3637,3639,3429,3431,3433,3644,3646,3436,3647,3438,3649,3651,3652,3654,3655,3657,3658,3446,3660,3661,3449,3663,3664,3665,3666,3667,3668,3669,3670,3670,3670,3671,3672,3673,3674,3675,3676,3677,3465,3679,3680,3468,3682,3683,3685,3686,3688,3689,3691,3476,3693,3478,3694,3696,3481,3483,3485,3701,3703,3488,3704,3490,3706,3708,3709,3711,3712,3714,3715,3498,3717,3718,3501,3720,3721,3722,3723,3724,3725,3726,3727,3727,3727,3728,3729,3730,3731,3732,3733,3734,3517,3736,3737,3520,3739,3740,3742,3743,3745,3746,3748,3528,3750,3530,3751,3753,3533,3535,3537,3758,3760,3540,3761,3542,3763,3765,3766,3768,3769,3771,3772,3550,3774,3775,3553,3777,3778,3779,3780,3781,3782,3783,3784,3784,3784,3785,3786,3787,3788,3789,3790,3791,3569,3793,3794,3572,3796,3797,3799,3800,3802,3803,3805,3580,3807,3582,3808,3810,3585,3587,3589,3815,3817,3592,3818,3594,3820,3822,3823,3825,3826,3828,3829,3602,3831,3832,3605,3834,3835,3836,3837,3838,3839,3840,3613,3841,3841,3842,3843,3844,3845,3846,3847,3848,3621,3850,3851,3624,3853,3854,3627,3856,3630,3858,3633,3860,3635,3861,3863,3638,3865,3640,3866,3641,3867,3642,3868,3643,3869,3645,3871,3873,3648,3874,3650,3876,3653,3878,3656,3880,3881,3659,3883,3884,3662,3886,3887,3888,3889,3890,3891,3892,3893,3893,3893,3894,3895,3896,3897,3898,3899,3900,3678,3902,3903,3681,3905,3906,3684,3908,3687,3910,3690,3912,3692,3913,3915,3695,3917,3697,3918,3698,3919,3699,3920,3700,3921,3702,3923,3925,3705,3926,3707,3928,3710,3930,3713,3932,3933,3716,3935,3936,3719,3938,3939,3940,3941,3942,3943,3944,3945,3945,3945,3946,3947,3948,3949,3950,3951,3952,3735,3954,3955,3738,3957,3958,3741,3960,3744,3962,3747,3964,3749,3965,3967,3752,3969,3754,3970,3755,3971,3756,3972,3757,3973,3759,3975,3977,3762,3978,3764,3980,3767,3982,3770,3984,3985,3773,3987,3988,3776,3990,3991,3992,3993,3994,3995,3996,3997,3997,3997,3998,3999,4000,4001,4002,4003,4004,3792,4006,4007,3795,4009,4010,3798,4012,3801,4014,3804,4016,3806,4017,4019,3809,4021,3811,4022,3812,4023,3813,4024,3814,4025,3816,4027,4029,3819,4030,3821,4032,3824,4034,3827,4036,4037,3830,4039,4040,3833,4042,4043,4044,4045,4046,4047,4048,3841,4049,4049,4050,4051,4052,4053,4054,4055,4056,3849,4058,4059,4060,3852,4061,4062,3855,4064,3857,4066,3859,4068,4070,3862,4072,3864,4073,4075,4077,4079,4081,4083,3870,4084,3872,4086,4088,3875,4090,3877,4092,3879,4094,4095,3882,4096,4097,4098,3885,4100,4101,4102,4103,4104,4105,4106,4107,4107,4107,4108,4109,4110,4111,4112,4113,4114,3901,4116,4117,4118,3904,4119,4120,3907,4122,3909,4124,3911,4126,4128,3914,4130,3916,4131,4133,4135,4137,4139,4141,3922,4142,3924,4144,4146,3927,4148,3929,4150,3931,4152,4153,3934,4154,4155,4156,3937,4158,4159,4160,4161,4162,4163,4164,4165,4165,4165,4166,4167,4168,4169,4170,4171,4172,3953,4174,4175,4176,3956,4177,4178,3959,4180,3961,4182,3963,4184,4186,3966,4188,3968,4189,4191,4193,4195,4197,4199,3974,4200,3976,4202,4204,3979,4206,3981,4208,3983,4210,4211,3986,4212,4213,4214,3989,4216,4217,4218,4219,4220,4221,4222,4223,4223,4223,4224,4225,4226,4227,4228,4229,4230,4005,4232,4233,4234,4008,4235,4236,4011,4238,4013,4240,4015,4242,4244,4018,4246,4020,4247,4249,4251,4253,4255,4257,4026,4258,4028,4260,4262,4031,4264,4033,4266,4035,4268,4269,4038,4270,4271,4272,4041,4274,4275,4276,4277,4278,4279,4280,4049,4281,4281,4282,4283,4284,4285,4286,4287,4288,4057,4290,4291,4292,4294,4295,4063,4297,4298,4065,4299,4300,4067,4301,4069,4303,4071,4304,4306,4074,4308,4076,4309,4078,4310,4080,4311,4082,4313,4315,4085,4316,4087,4318,4089,4319,4320,4091,4321,4322,4093,4324,4325,4327,4328,4329,4099,4331,4332,4333,4334,4335,4336,4337,4338,4338,4338,4339,4340,4341,4342,4343,4344,4345,4115,4347,4348,4349,4351,4352,4121,4354,4355,4123,4356,4357,4125,4358,4127,4360,4129,4361,4363,4132,4365,4134,4366,4136,4367,4138,4368,4140,4370,4372,4143,4373,4145,4375,4147,4376,4377,4149,4378,4379,4151,4381,4382,4384,4385,4386,4157,4388,4389,4390,4391,4392,4393,4394,4395,4395,4395,4396,4397,4398,4399,4400,4401,4402,4173,4404,4405,4406,4408,4409,4179,4411,4412,4181,4413,4414,4183,4415,4185,4417,4187,4418,4420,4190,4422,4192,4423,4194,4424,4196,4425,4198,4427,4429,4201,4430,4203,4432,4205,4433,4434,4207,4435,4436,4209,4438,4439,4441,4442,4443,4215,4445,4446,4447,4448,4449,4450,4451,4452,4452,4452,4453,4454,4455,4456,4457,4458,4459,4231,4461,4462,4463,4465,4466,4237,4468,4469,4239,4470,4471,4241,4472,4243,4474,4245,4475,4477,4248,4479,4250,4480,4252,4481,4254,4482,4256,4484,4486,4259,4487,4261,4489,4263,4490,4491,4265,4492,4493,4267,4495,4496,4498,4499,4500,4273,4502,4503,4504,4505,4506,4507,4508,4281,4509,4509,4510,4511,4512,4513,4514,4515,4516,4289,4518,4519,4520,4293,4522,4523,4296,4524,4525,4527,4528,4530,4531,4302,4532,4534,4305,4536,4307,4537,4539,4541,4543,4545,4312,4546,4314,4548,4550,4317,4551,4552,4554,4555,4557,4558,4323,4559,4560,4326,4562,4563,4564,4330,4566,4567,4568,4569,4570,4571,4572,4573,4573,4573,4574,4575,4576,4577,4578,4579,4580,4346,4582,4583,4584,4350,4586,4587,4353,4588,4589,4591,4592,4594,4595,4359,4596,4598,4362,4600,4364,4601,4603,4605,4607,4609,4369,4610,4371,4612,4614,4374,4615,4616,4618,4619,4621,4622,4380,4623,4624,4383,4626,4627,4628,4387,4630,4631,4632,4633,4634,4635,4636,4637,4637,4637,4638,4639,4640,4641,4642,4643,4644,4403,4646,4647,4648,4407,4650,4651,4410,4652,4653,4655,4656,4658,4659,4416,4660,4662,4419,4664,4421,4665,4667,4669,4671,4673,4426,4674,4428,4676,4678,4431,4679,4680,4682,4683,4685,4686,4437,4687,4688,4440,4690,4691,4692,4444,4694,4695,4696,4697,4698,4699,4700,4701,4701,4701,4702,4703,4704,4705,4706,4707,4708,4460,4710,4711,4712,4464,4714,4715,4467,4716,4717,4719,4720,4722,4723,4473,4724,4726,4476,4728,4478,4729,4731,4733,4735,4737,4483,4738,4485,4740,4742,4488,4743,4744,4746,4747,4749,4750,4494,4751,4752,4497,4754,4755,4756,4501,4758,4759,4760,4761,4762,4763,4764,4509,4765,4765,4766,4767,4768,4769,4770,4771,4772,4517,4774,4775,4776,4521,4778,4779,4781,4782,4526,4784,4529,4786,4788,4533,4790,4535,4791,4793,4538,4540,4542,4544,4799,4801,4547,4802,4549,4804,4806,4553,4808,4556,4810,4811,4813,4814,4561,4816,4817,4818,4565,4820,4821,4822,4823,4824,4825,4826,4827,4827,4827,4828,4829,4830,4831,4832,4833,4834,4581,4836,4837,4838,4585,4840,4841,4843,4844,4590,4846,4593,4848,4850,4597,4852,4599,4853,4855,4602,4604,4606,4608,4861,4863,4611,4864,4613,4866,4868,4617,4870,4620,4872,4873,4875,4876,4625,4878,4879,4880,4629,4882,4883,4884,4885,4886,4887,4888,4889,4889,4889,4890,4891,4892,4893,4894,4895,4896,4645,4898,4899,4900,4649,4902,4903,4905,4906,4654,4908,4657,4910,4912,4661,4914,4663,4915,4917,4666,4668,4670,4672,4923,4925,4675,4926,4677,4928,4930,4681,4932,4684,4934,4935,4937,4938,4689,4940,4941,4942,4693,4944,4945,4946,4947,4948,4949,4950,4951,4951,4951,4952,4953,4954,4955,4956,4957,4958,4709,4960,4961,4962,4713,4964,4965,4967,4968,4718,4970,4721,4972,4974,4725,4976,4727,4977,4979,4730,4732,4734,4736,4985,4987,4739,4988,4741,4990,4992,4745,4994,4748,4996,4997,4999,5000,4753,5002,5003,5004,4757,5006,5007,5008,5009,5010,5011,5012,4765,5013,5013,5014,5015,5016,5017,5018,5019,5020,5021,4773,5022,5023,5024,4777,5026,5027,4780,5029,4783,5031,4785,5033,4787,5035,4789,5036,5038,4792,5040,4794,5041,4795,5042,4796,5043,4797,5044,4798,5045,4800,5047,5049,4803,5050,4805,5052,4807,5054,4809,5056,4812,5058,5059,4815,5061,5062,5063,4819,5064,5065,5066,5067,5068,5069,5070,5071,5072,5072,5072,5073,5074,5075,5076,5077,5078,5079,5080,4835,5081,5082,5083,4839,5085,5086,4842,5088,4845,5090,4847,5092,4849,5094,4851,5095,5097,4854,5099,4856,5100,4857,5101,4858,5102,4859,5103,4860,5104,4862,5106,5108,4865,5109,4867,5111,4869,5113,4871,5115,4874,5117,5118,4877,5120,5121,5122,4881,5123,5124,5125,5126,5127,5128,5129,5130,5131,5131,5131,5132,5133,5134,5135,5136,5137,5138,5139,4897,5140,5141,5142,4901,5144,5145,4904,5147,4907,5149,4909,5151,4911,5153,4913,5154,5156,4916,5158,4918,5159,4919,5160,4920,5161,4921,5162,4922,5163,4924,5165,5167,4927,5168,4929,5170,4931,5172,4933,5174,4936,5176,5177,4939,5179,5180,5181,4943,5182,5183,5184,5185,5186,5187,5188,5189,5190,5190,5190,5191,5192,5193,5194,5195,5196,5197,5198,4959,5199,5200,5201,4963,5203,5204,4966,5206,4969,5208,4971,5210,4973,5212,4975,5213,5215,4978,5217,4980,5218,4981,5219,4982,5220,4983,5221,4984,5222,4986,5224,5226,4989,5227,4991,5229,4993,5231,4995,5233,4998,5235,5236,5001,5238,5239,5240,5005,5241,5242,5243,5244,5245,5246,5247,5248,5013,5249,5249,5250,5251,5252,5253,5254,5255,5256,5257,5259,5260,5261,5025,5263,5264,5028,5266,5267,5030,5268,5269,5032,5270,5034,5272,5274,5037,5276,5039,5277,5279,5281,5283,5285,5287,5289,5046,5290,5048,5292,5294,5051,5296,5053,5297,5298,5055,5299,5300,5057,5302,5303,5060,5305,5306,5307,5309,5310,5311,5312,5313,5314,5315,5316,5317,5317,5317,5318,5319,5320,5321,5322,5323,5324,5325,5327,5328,5329,5084,5331,5332,5087,5334,5335,5089,5336,5337,5091,5338,5093,5340,5342,5096,5344,5098,5345,5347,5349,5351,5353,5355,5357,5105,5358,5107,5360,5362,5110,5364,5112,5365,5366,5114,5367,5368,5116,5370,5371,5119,5373,5374,5375,5377,5378,5379,5380,5381,5382,5383,5384,5385,5385,5385,5386,5387,5388,5389,5390,5391,5392,5393,5395,5396,5397,5143,5399,5400,5146,5402,5403,5148,5404,5405,5150,5406,5152,5408,5410,5155,5412,5157,5413,5415,5417,5419,5421,5423,5425,5164,5426,5166,5428,5430,5169,5432,5171,5433,5434,5173,5435,5436,5175,5438,5439,5178,5441,5442,5443,5445,5446,5447,5448,5449,5450,5451,5452,5453,5453,5453,5454,5455,5456,5457,5458,5459,5460,5461,5463,5464,5465,5202,5467,5468,5205,5470,5471,5207,5472,5473,5209,5474,5211,5476,5478,5214,5480,5216,5481,5483,5485,5487,5489,5491,5493,5223,5494,5225,5496,5498,5228,5500,5230,5501,5502,5232,5503,5504,5234,5506,5507,5237,5509,5510,5511,5513,5514,5515,5516,5517,5518,5519,5520,5249,5521,5521,5522,5523,5524,5525,5526,5527,5528,5529,5258,5531,5532,5533,5262,5534,5535,5265,5537,5538,5540,5541,5543,5544,5271,5545,5273,5547,5275,5548,5550,5278,5552,5280,5553,5282,5554,5284,5555,5286,5556,5288,5558,5560,5291,5561,5293,5563,5295,5564,5565,5567,5568,5570,5571,5301,5573,5574,5304,5575,5576,5577,5308,5579,5580,5581,5582,5583,5584,5585,5586,5587,5587,5587,5588,5589,5590,5591,5592,5593,5594,5595,5326,5597,5598,5599,5330,5600,5601,5333,5603,5604,5606,5607,5609,5610,5339,5611,5341,5613,5343,5614,5616,5346,5618,5348,5619,5350,5620,5352,5621,5354,5622,5356,5624,5626,5359,5627,5361,5629,5363,5630,5631,5633,5634,5636,5637,5369,5639,5640,5372,5641,5642,5643,5376,5645,5646,5647,5648,5649,5650,5651,5652,5653,5653,5653,5654,5655,5656,5657,5658,5659,5660,5661,5394,5663,5664,5665,5398,5666,5667,5401,5669,5670,5672,5673,5675,5676,5407,5677,5409,5679,5411,5680,5682,5414,5684,5416,5685,5418,5686,5420,5687,5422,5688,5424,5690,5692,5427,5693,5429,5695,5431,5696,5697,5699,5700,5702,5703,5437,5705,5706,5440,5707,5708,5709,5444,5711,5712,5713,5714,5715,5716,5717,5718,5719,5719,5719,5720,5721,5722,5723,5724,5725,5726,5727,5462,5729,5730,5731,5466,5732,5733,5469,5735,5736,5738,5739,5741,5742,5475,5743,5477,5745,5479,5746,5748,5482,5750,5484,5751,5486,5752,5488,5753,5490,5754,5492,5756,5758,5495,5759,5497,5761,5499,5762,5763,5765,5766,5768,5769,5505,5771,5772,5508,5773,5774,5775,5512,5777,5778,5779,5780,5781,5782,5783,5784,5521,5785,5785,5786,5787,5788,5789,5790,5791,5792,5793,5530,5795,5796,5797,5799,5800,5801,5536,5802,5803,5539,5805,5542,5807,5809,5810,5546,5811,5813,5549,5815,5551,5816,5818,5820,5822,5824,5826,5557,5827,5559,5829,5831,5562,5832,5833,5835,5566,5837,5569,5839,5840,5572,5841,5842,5843,5845,5846,5847,5578,5849,5850,5851,5852,5853,5854,5855,5856,5857,5857,5857,5858,5859,5860,5861,5862,5863,5864,5865,5596,5867,5868,5869,5871,5872,5873,5602,5874,5875,5605,5877,5608,5879,5881,5882,5612,5883,5885,5615,5887,5617,5888,5890,5892,5894,5896,5898,5623,5899,5625,5901,5903,5628,5904,5905,5907,5632,5909,5635,5911,5912,5638,5913,5914,5915,5917,5918,5919,5644,5921,5922,5923,5924,5925,5926,5927,5928,5929,5929,5929,5930,5931,5932,5933,5934,5935,5936,5937,5662,5939,5940,5941,5943,5944,5945,5668,5946,5947,5671,5949,5674,5951,5953,5954,5678,5955,5957,5681,5959,5683,5960,5962,5964,5966,5968,5970,5689,5971,5691,5973,5975,5694,5976,5977,5979,5698,5981,5701,5983,5984,5704,5985,5986,5987,5989,5990,5991,5710,5993,5994,5995,5996,5997,5998,5999,6000,6001,6001,6001,6002,6003,6004,6005,6006,6007,6008,6009,5728,6011,6012,6013,6015,6016,6017,5734,6018,6019,5737,6021,5740,6023,6025,6026,5744,6027,6029,5747,6031,5749,6032,6034,6036,6038,6040,6042,5755,6043,5757,6045,6047,5760,6048,6049,6051,5764,6053,5767,6055,6056,5770,6057,6058,6059,6061,6062,6063,5776,6065,6066,6067,6068,6069,6070,6071,6072,5785,6073,6073,6074,6075,6076,6077,6078,6079,6080,6081,5794,6083,6084,6085,5798,6087,6088,6090,6091,5804,6093,5806,6095,5808,6097,6099,5812,6101,5814,6102,6104,5817,5819,6107,5821,6108,5823,5825,6111,6113,5828,6114,5830,6116,6118,5834,6120,5836,6122,5838,6124,6125,6127,6128,5844,6130,6131,6132,5848,6134,6135,6136,6137,6138,6139,6140,6141,6142,6142,6142,6143,6144,6145,6146,6147,6148,6149,6150,5866,6152,6153,6154,5870,6156,6157,6159,6160,5876,6162,5878,6164,5880,6166,6168,5884,6170,5886,6171,6173,5889,5891,6176,5893,6177,5895,5897,6180,6182,5900,6183,5902,6185,6187,5906,6189,5908,6191,5910,6193,6194,6196,6197,5916,6199,6200,6201,5920,6203,6204,6205,6206,6207,6208,6209,6210,6211,6211,6211,6212,6213,6214,6215,6216,6217,6218,6219,5938,6221,6222,6223,5942,6225,6226,6228,6229,5948,6231,5950,6233,5952,6235,6237,5956,6239,5958,6240,6242,5961,5963,6245,5965,6246,5967,5969,6249,6251,5972,6252,5974,6254,6256,5978,6258,5980,6260,5982,6262,6263,6265,6266,5988,6268,6269,6270,5992,6272,6273,6274,6275,6276,6277,6278,6279,6280,6280,6280,6281,6282,6283,6284,6285,6286,6287,6288,6010,6290,6291,6292,6014,6294,6295,6297,6298,6020,6300,6022,6302,6024,6304,6306,6028,6308,6030,6309,6311,6033,6035,6314,6037,6315,6039,6041,6318,6320,6044,6321,6046,6323,6325,6050,6327,6052,6329,6054,6331,6332,6334,6335,6060,6337,6338,6339,6064,6341,6342,6343,6344,6345,6346,6347,6348,6073,6349,6349,6350,6351,6352,6353,6354,6355,6356,6357,6082,6359,6360,6361,6086,6363,6364,6089,6366,6092,6368,6369,6094,6370,6096,6372,6098,6374,6100,6375,6377,6103,6379,6105,6380,6106,6381,6383,6385,6109,6386,6110,6387,6112,6389,6391,6115,6392,6117,6394,6119,6396,6121,6397,6398,6123,6400,6126,6402,6403,6129,6405,6406,6407,6133,6409,6410,6411,6412,6413,6414,6415,6416,6417,6417,6417,6418,6419,6420,6421,6422,6423,6424,6425,6151,6427,6428,6429,6155,6431,6432,6158,6434,6161,6436,6437,6163,6438,6165,6440,6167,6442,6169,6443,6445,6172,6447,6174,6448,6175,6449,6451,6453,6178,6454,6179,6455,6181,6457,6459,6184,6460,6186,6462,6188,6464,6190,6465,6466,6192,6468,6195,6470,6471,6198,6473,6474,6475,6202,6477,6478,6479,6480,6481,6482,6483,6484,6485,6485,6485,6486,6487,6488,6489,6490,6491,6492,6493,6220,6495,6496,6497,6224,6499,6500,6227,6502,6230,6504,6505,6232,6506,6234,6508,6236,6510,6238,6511,6513,6241,6515,6243,6516,6244,6517,6519,6521,6247,6522,6248,6523,6250,6525,6527,6253,6528,6255,6530,6257,6532,6259,6533,6534,6261,6536,6264,6538,6539,6267,6541,6542,6543,6271,6545,6546,6547,6548,6549,6550,6551,6552,6553,6553,6553,6554,6555,6556,6557,6558,6559,6560,6561,6289,6563,6564,6565,6293,6567,6568,6296,6570,6299,6572,6573,6301,6574,6303,6576,6305,6578,6307,6579,6581,6310,6583,6312,6584,6313,6585,6587,6589,6316,6590,6317,6591,6319,6593,6595,6322,6596,6324,6598,6326,6600,6328,6601,6602,6330,6604,6333,6606,6607,6336,6609,6610,6611,6340,6613,6614,6615,6616,6617,6618,6619,6620,6349,6621,6621,6622,6623,6624,6625,6626,6627,6628,6629,6358,6631,6632,6633,6362,6635,6636,6365,6638,6639,6367,6640,6641,6643,6644,6371,6645,6373,6647,6649,6376,6651,6378,6652,6654,6656,6382,6384,6660,6662,6664,6388,6665,6390,6667,6669,6393,6671,6395,6672,6673,6675,6676,6399,6677,6678,6401,6680,6681,6404,6683,6684,6685,6408,6687,6688,6689,6690,6691,6692,6693,6694,6695,6695,6695,6696,6697,6698,6699,6700,6701,6702,6703,6426,6705,6706,6707,6430,6709,6710,6433,6712,6713,6435,6714,6715,6717,6718,6439,6719,6441,6721,6723,6444,6725,6446,6726,6728,6730,6450,6452,6734,6736,6738,6456,6739,6458,6741,6743,6461,6745,6463,6746,6747,6749,6750,6467,6751,6752,6469,6754,6755,6472,6757,6758,6759,6476,6761,6762,6763,6764,6765,6766,6767,6768,6769,6769,6769,6770,6771,6772,6773,6774,6775,6776,6777,6494,6779,6780,6781,6498,6783,6784,6501,6786,6787,6503,6788,6789,6791,6792,6507,6793,6509,6795,6797,6512,6799,6514,6800,6802,6804,6518,6520,6808,6810,6812,6524,6813,6526,6815,6817,6529,6819,6531,6820,6821,6823,6824,6535,6825,6826,6537,6828,6829,6540,6831,6832,6833,6544,6835,6836,6837,6838,6839,6840,6841,6842,6843,6843,6843,6844,6845,6846,6847,6848,6849,6850,6851,6562,6853,6854,6855,6566,6857,6858,6569,6860,6861,6571,6862,6863,6865,6866,6575,6867,6577,6869,6871,6580,6873,6582,6874,6876,6878,6586,6588,6882,6884,6886,6592,6887,6594,6889,6891,6597,6893,6599,6894,6895,6897,6898,6603,6899,6900,6605,6902,6903,6608,6905,6906,6907,6612,6909,6910,6911,6912,6913,6914,6915,6916,6621,6917,6917,6918,6919,6920,6921,6922,6923,6924,6925,6630,6927,6928,6929,6634,6931,6932,6637,6934,6935,6937,6938,6642,6940,6942,6943,6646,6944,6648,6946,6650,6947,6949,6653,6951,6655,6952,6657,6953,6658,6954,6659,6955,6661,6956,6663,6958,6960,6666,6961,6668,6963,6670,6964,6965,6967,6674,6969,6970,6972,6973,6679,6975,6976,6682,6978,6979,6980,6686,6982,6983,6984,6985,6986,6987,6988,6989,6990,6990,6990,6991,6992,6993,6994,6995,6996,6997,6998,6704,7000,7001,7002,6708,7004,7005,6711,7007,7008,7010,7011,6716,7013,7015,7016,6720,7017,6722,7019,6724,7020,7022,6727,7024,6729,7025,6731,7026,6732,7027,6733,7028,6735,7029,6737,7031,7033,6740,7034,6742,7036,6744,7037,7038,7040,6748,7042,7043,7045,7046,6753,7048,7049,6756,7051,7052,7053,6760,7055,7056,7057,7058,7059,7060,7061,7062,7063,7063,7063,7064,7065,7066,7067,7068,7069,7070,7071,6778,7073,7074,7075,6782,7077,7078,6785,7080,7081,7083,7084,6790,7086,7088,7089,6794,7090,6796,7092,6798,7093,7095,6801,7097,6803,7098,6805,7099,6806,7100,6807,7101,6809,7102,6811,7104,7106,6814,7107,6816,7109,6818,7110,7111,7113,6822,7115,7116,7118,7119,6827,7121,7122,6830,7124,7125,7126,6834,7128,7129,7130,7131,7132,7133,7134,7135,7136,7136,7136,7137,7138,7139,7140,7141,7142,7143,7144,6852,7146,7147,7148,6856,7150,7151,6859,7153,7154,7156,7157,6864,7159,7161,7162,6868,7163,6870,7165,6872,7166,7168,6875,7170,6877,7171,6879,7172,6880,7173,6881,7174,6883,7175,6885,7177,7179,6888,7180,6890,7182,6892,7183,7184,7186,6896,7188,7189,7191,7192,6901,7194,7195,6904,7197,7198,7199,6908,7201,7202,7203,7204,7205,7206,7207,7208,6917,7209,7209,7210,7211,7212,7213,7214,7215,7216,7217,6926,7219,7220,7221,6930,7223,7224,7225,6933,7226,7227,6936,7229,6939,7231,6941,7233,7235,7236,6945,7237,7239,6948,7241,6950,7242,7244,7246,7248,7250,7252,7254,6957,7255,6959,7257,7259,6962,7260,7261,7263,6966,7265,6968,7267,6971,7269,7270,6974,7271,7272,7273,6977,7275,7276,7277,6981,7279,7280,7281,7282,7283,7284,7285,7286,7287,7287,7287,7288,7289,7290,7291,7292,7293,7294,7295,6999,7297,7298,7299,7003,7301,7302,7303,7006,7304,7305,7009,7307,7012,7309,7014,7311,7313,7314,7018,7315,7317,7021,7319,7023,7320,7322,7324,7326,7328,7330,7332,7030,7333,7032,7335,7337,7035,7338,7339,7341,7039,7343,7041,7345,7044,7347,7348,7047,7349,7350,7351,7050,7353,7354,7355,7054,7357,7358,7359,7360,7361,7362,7363,7364,7365,7365,7365,7366,7367,7368,7369,7370,7371,7372,7373,7072,7375,7376,7377,7076,7379,7380,7381,7079,7382,7383,7082,7385,7085,7387,7087,7389,7391,7392,7091,7393,7395,7094,7397,7096,7398,7400,7402,7404,7406,7408,7410,7103,7411,7105,7413,7415,7108,7416,7417,7419,7112,7421,7114,7423,7117,7425,7426,7120,7427,7428,7429,7123,7431,7432,7433,7127,7435,7436,7437,7438,7439,7440,7441,7442,7443,7443,7443,7444,7445,7446,7447,7448,7449,7450,7451,7145,7453,7454,7455,7149,7457,7458,7459,7152,7460,7461,7155,7463,7158,7465,7160,7467,7469,7470,7164,7471,7473,7167,7475,7169,7476,7478,7480,7482,7484,7486,7488,7176,7489,7178,7491,7493,7181,7494,7495,7497,7185,7499,7187,7501,7190,7503,7504,7193,7505,7506,7507,7196,7509,7510,7511,7200,7513,7514,7515,7516,7517,7518,7519,7520,7209,7521,7521,7522,7523,7524,7525,7526,7527,7528,7529,7530,7218,7531,7532,7533,7534,7222,7535,7536,7537,7539,7540,7228,7542,7543,7230,7544,7232,7546,7234,7548,7550,7238,7552,7240,7553,7555,7243,7557,7245,7558,7247,7559,7249,7560,7251,7561,7253,7563,7565,7256,7566,7258,7568,7570,7262,7572,7264,7574,7266,7575,7576,7268,7578,7579,7581,7582,7583,7274,7584,7585,7586,7587,7278,7588,7589,7590,7591,7592,7593,7594,7595,7596,7597,7597,7597,7598,7599,7600,7601,7602,7603,7604,7605,7606,7296,7607,7608,7609,7610,7300,7611,7612,7613,7615,7616,7306,7618,7619,7308,7620,7310,7622,7312,7624,7626,7316,7628,7318,7629,7631,7321,7633,7323,7634,7325,7635,7327,7636,7329,7637,7331,7639,7641,7334,7642,7336,7644,7646,7340,7648,7342,7650,7344,7651,7652,7346,7654,7655,7657,7658,7659,7352,7660,7661,7662,7663,7356,7664,7665,7666,7667,7668,7669,7670,7671,7672,7673,7673,7673,7674,7675,7676,7677,7678,7679,7680,7681,7682,7374,7683,7684,7685,7686,7378,7687,7688,7689,7691,7692,7384,7694,7695,7386,7696,7388,7698,7390,7700,7702,7394,7704,7396,7705,7707,7399,7709,7401,7710,7403,7711,7405,7712,7407,7713,7409,7715,7717,7412,7718,7414,7720,7722,7418,7724,7420,7726,7422,7727,7728,7424,7730,7731,7733,7734,7735,7430,7736,7737,7738,7739,7434,7740,7741,7742,7743,7744,7745,7746,7747,7748,7749,7749,7749,7750,7751,7752,7753,7754,7755,7756,7757,7758,7452,7759,7760,7761,7762,7456,7763,7764,7765,7767,7768,7462,7770,7771,7464,7772,7466,7774,7468,7776,7778,7472,7780,7474,7781,7783,7477,7785,7479,7786,7481,7787,7483,7788,7485,7789,7487,7791,7793,7490,7794,7492,7796,7798,7496,7800,7498,7802,7500,7803,7804,7502,7806,7807,7809,7810,7811,7508,7812,7813,7814,7815,7512,7816,7817,7818,7819,7820,7821,7822,7823,7824,7521,7825,7825,7826,7827,7828,7829,7830,7831,7832,7833,7834,7836,7837,7838,7839,7841,7842,7843,7538,7845,7541,7847,7848,7850,7851,7545,7852,7853,7547,7854,7549,7856,7551,7857,7859,7554,7861,7556,7862,7864,7866,7868,7870,7872,7562,7873,7564,7875,7877,7567,7878,7569,7880,7571,7881,7882,7573,7883,7884,7886,7887,7577,7889,7580,7891,7892,7893,7895,7896,7897,7898,7900,7901,7902,7903,7904,7905,7906,7907,7908,7909,7909,7909,7910,7911,7912,7913,7914,7915,7916,7917,7918,7920,7921,7922,7923,7925,7926,7927,7614,7929,7617,7931,7932,7934,7935,7621,7936,7937,7623,7938,7625,7940,7627,7941,7943,7630,7945,7632,7946,7948,7950,7952,7954,7956,7638,7957,7640,7959,7961,7643,7962,7645,7964,7647,7965,7966,7649,7967,7968,7970,7971,7653,7973,7656,7975,7976,7977,7979,7980,7981,7982,7984,7985,7986,7987,7988,7989,7990,7991,7992,7993,7993,7993,7994,7995,7996,7997,7998,7999,8000,8001,8002,8004,8005,8006,8007,8009,8010,8011,7690,8013,7693,8015,8016,8018,8019,7697,8020,8021,7699,8022,7701,8024,7703,8025,8027,7706,8029,7708,8030,8032,8034,8036,8038,8040,7714,8041,7716,8043,8045,7719,8046,7721,8048,7723,8049,8050,7725,8051,8052,8054,8055,7729,8057,7732,8059,8060,8061,8063,8064,8065,8066,8068,8069,8070,8071,8072,8073,8074,8075,8076,8077,8077,8077,8078,8079,8080,8081,8082,8083,8084,8085,8086,8088,8089,8090,8091,8093,8094,8095,7766,8097,7769,8099,8100,8102,8103,7773,8104,8105,7775,8106,7777,8108,7779,8109,8111,7782,8113,7784,8114,8116,8118,8120,8122,8124,7790,8125,7792,8127,8129,7795,8130,7797,8132,7799,8133,8134,7801,8135,8136,8138,8139,7805,8141,7808,8143,8144,8145,8147,8148,8149,8150,8152,8153,8154,8155,8156,8157,8158,8159,8160,7825,8161,8161,8162,8163,8164,8165,8166,8167,8168,8169,8170,7835,8172,8173,8174,7840,8176,8177,7844,8179,8180,7846,8181,8182,7849,8184,8186,8187,8189,7855,8191,8193,7858,8195,7860,8196,8198,7863,7865,7867,7869,7871,8205,8207,7874,8208,7876,8210,8212,7879,8214,8216,8217,8219,7885,8221,8222,7888,8223,8224,7890,8226,8227,7894,8229,8230,8231,7899,8233,8234,8235,8236,8237,8238,8239,8240,8241,8242,8242,8242,8243,8244,8245,8246,8247,8248,8249,8250,8251,7919,8253,8254,8255,7924,8257,8258,7928,8260,8261,7930,8262,8263,7933,8265,8267,8268,8270,7939,8272,8274,7942,8276,7944,8277,8279,7947,7949,7951,7953,7955,8286,8288,7958,8289,7960,8291,8293,7963,8295,8297,8298,8300,7969,8302,8303,7972,8304,8305,7974,8307,8308,7978,8310,8311,8312,7983,8314,8315,8316,8317,8318,8319,8320,8321,8322,8323,8323,8323,8324,8325,8326,8327,8328,8329,8330,8331,8332,8003,8334,8335,8336,8008,8338,8339,8012,8341,8342,8014,8343,8344,8017,8346,8348,8349,8351,8023,8353,8355,8026,8357,8028,8358,8360,8031,8033,8035,8037,8039,8367,8369,8042,8370,8044,8372,8374,8047,8376,8378,8379,8381,8053,8383,8384,8056,8385,8386,8058,8388,8389,8062,8391,8392,8393,8067,8395,8396,8397,8398,8399,8400,8401,8402,8403,8404,8404,8404,8405,8406,8407,8408,8409,8410,8411,8412,8413,8087,8415,8416,8417,8092,8419,8420,8096,8422,8423,8098,8424,8425,8101,8427,8429,8430,8432,8107,8434,8436,8110,8438,8112,8439,8441,8115,8117,8119,8121,8123,8448,8450,8126,8451,8128,8453,8455,8131,8457,8459,8460,8462,8137,8464,8465,8140,8466,8467,8142,8469,8470,8146,8472,8473,8474,8151,8476,8477,8478,8479,8480,8481,8482,8483,8484,8161,8485,8485,8486,8487,8488,8489,8490,8491,8492,8493,8494,8171,8496,8497,8498,8175,8500,8501,8178,8503,8504,8506,8507,8183,8509,8185,8511,8188,8513,8190,8514,8192,8516,8194,8517,8519,8197,8521,8199,8522,8200,8523,8201,8524,8202,8525,8203,8526,8204,8527,8206,8529,8531,8209,8532,8211,8534,8213,8535,8215,8537,8218,8539,8220,8541,8542,8544,8545,8225,8547,8548,8228,8550,8551,8552,8232,8554,8555,8556,8557,8558,8559,8560,8561,8562,8563,8563,8563,8564,8565,8566,8567,8568,8569,8570,8571,8572,8252,8574,8575,8576,8256,8578,8579,8259,8581,8582,8584,8585,8264,8587,8266,8589,8269,8591,8271,8592,8273,8594,8275,8595,8597,8278,8599,8280,8600,8281,8601,8282,8602,8283,8603,8284,8604,8285,8605,8287,8607,8609,8290,8610,8292,8612,8294,8613,8296,8615,8299,8617,8301,8619,8620,8622,8623,8306,8625,8626,8309,8628,8629,8630,8313,8632,8633,8634,8635,8636,8637,8638,8639,8640,8641,8641,8641,8642,8643,8644,8645,8646,8647,8648,8649,8650,8333,8652,8653,8654,8337,8656,8657,8340,8659,8660,8662,8663,8345,8665,8347,8667,8350,8669,8352,8670,8354,8672,8356,8673,8675,8359,8677,8361,8678,8362,8679,8363,8680,8364,8681,8365,8682,8366,8683,8368,8685,8687,8371,8688,8373,8690,8375,8691,8377,8693,8380,8695,8382,8697,8698,8700,8701,8387,8703,8704,8390,8706,8707,8708,8394,8710,8711,8712,8713,8714,8715,8716,8717,8718,8719,8719,8719,8720,8721,8722,8723,8724,8725,8726,8727,8728,8414,8730,8731,8732,8418,8734,8735,8421,8737,8738,8740,8741,8426,8743,8428,8745,8431,8747,8433,8748,8435,8750,8437,8751,8753,8440,8755,8442,8756,8443,8757,8444,8758,8445,8759,8446,8760,8447,8761,8449,8763,8765,8452,8766,8454,8768,8456,8769,8458,8771,8461,8773,8463,8775,8776,8778,8779,8468,8781,8782,8471,8784,8785,8786,8475,8788,8789,8790,8791,8792,8793,8794,8795,8796,8485,8797,8797,8798,8799,8800,8801,8802,8803,8804,8805,8806,8495,8808,8809,8810,8499,8812,8813,8502,8815,8816,8505,8818,8508,8820,8510,8822,8512,8824,8826,8827,8515,8828,8830,8518,8832,8520,8833,8835,8837,8839,8841,8843,8845,8847,8528,8848,8530,8850,8852,8533,8853,8854,8856,8536,8858,8538,8860,8540,8862,8543,8864,8865,8546,8867,8868,8549,8870,8871,8872,8553,8874,8875,8876,8877,8878,8879,8880,8881,8882,8883,8883,8883,8884,8885,8886,8887,8888,8889,8890,8891,8892,8573,8894,8895,8896,8577,8898,8899,8580,8901,8902,8583,8904,8586,8906,8588,8908,8590,8910,8912,8913,8593,8914,8916,8596,8918,8598,8919,8921,8923,8925,8927,8929,8931,8933,8606,8934,8608,8936,8938,8611,8939,8940,8942,8614,8944,8616,8946,8618,8948,8621,8950,8951,8624,8953,8954,8627,8956,8957,8958,8631,8960,8961,8962,8963,8964,8965,8966,8967,8968,8969,8969,8969,8970,8971,8972,8973,8974,8975,8976,8977,8978,8651,8980,8981,8982,8655,8984,8985,8658,8987,8988,8661,8990,8664,8992,8666,8994,8668,8996,8998,8999,8671,9000,9002,8674,9004,8676,9005,9007,9009,9011,9013,9015,9017,9019,8684,9020,8686,9022,9024,8689,9025,9026,9028,8692,9030,8694,9032,8696,9034,8699,9036,9037,8702,9039,9040,8705,9042,9043,9044,8709,9046,9047,9048,9049,9050,9051,9052,9053,9054,9055,9055,9055,9056,9057,9058,9059,9060,9061,9062,9063,9064,8729,9066,9067,9068,8733,9070,9071,8736,9073,9074,8739,9076,8742,9078,8744,9080,8746,9082,9084,9085,8749,9086,9088,8752,9090,8754,9091,9093,9095,9097,9099,9101,9103,9105,8762,9106,8764,9108,9110,8767,9111,9112,9114,8770,9116,8772,9118,8774,9120,8777,9122,9123,8780,9125,9126,8783,9128,9129,9130,8787,9132,9133,9134,9135,9136,9137,9138,9139,9140,8797,9141,9141,9142,9143,9144,9145,9146,9147,9148,9149,9150,8807,9152,9153,9154,8811,9156,9157,9158,8814,9159,9160,8817,9162,9163,8819,9164,9165,8821,9166,9167,8823,9168,8825,9170,9172,8829,9174,8831,9175,9177,8834,9179,8836,9180,8838,9181,8840,9182,8842,9183,8844,9184,8846,9186,9188,8849,9189,8851,9191,9193,8855,9195,8857,9196,9197,8859,9198,9199,8861,9200,9201,8863,9203,9204,8866,9205,9206,9207,8869,9209,9210,9211,8873,9213,9214,9215,9216,9217,9218,9219,9220,9221,9222,9222,9222,9223,9224,9225,9226,9227,9228,9229,9230,9231,8893,9233,9234,9235,8897,9237,9238,9239,8900,9240,9241,8903,9243,9244,8905,9245,9246,8907,9247,9248,8909,9249,8911,9251,9253,8915,9255,8917,9256,9258,8920,9260,8922,9261,8924,9262,8926,9263,8928,9264,8930,9265,8932,9267,9269,8935,9270,8937,9272,9274,8941,9276,8943,9277,9278,8945,9279,9280,8947,9281,9282,8949,9284,9285,8952,9286,9287,9288,8955,9290,9291,9292,8959,9294,9295,9296,9297,9298,9299,9300,9301,9302,9303,9303,9303,9304,9305,9306,9307,9308,9309,9310,9311,9312,8979,9314,9315,9316,8983,9318,9319,9320,8986,9321,9322,8989,9324,9325,8991,9326,9327,8993,9328,9329,8995,9330,8997,9332,9334,9001,9336,9003,9337,9339,9006,9341,9008,9342,9010,9343,9012,9344,9014,9345,9016,9346,9018,9348,9350,9021,9351,9023,9353,9355,9027,9357,9029,9358,9359,9031,9360,9361,9033,9362,9363,9035,9365,9366,9038,9367,9368,9369,9041,9371,9372,9373,9045,9375,9376,9377,9378,9379,9380,9381,9382,9383,9384,9384,9384,9385,9386,9387,9388,9389,9390,9391,9392,9393,9065,9395,9396,9397,9069,9399,9400,9401,9072,9402,9403,9075,9405,9406,9077,9407,9408,9079,9409,9410,9081,9411,9083,9413,9415,9087,9417,9089,9418,9420,9092,9422,9094,9423,9096,9424,9098,9425,9100,9426,9102,9427,9104,9429,9431,9107,9432,9109,9434,9436,9113,9438,9115,9439,9440,9117,9441,9442,9119,9443,9444,9121,9446,9447,9124,9448,9449,9450,9127,9452,9453,9454,9131,9456,9457,9458,9459,9460,9461,9462,9463,9464,9141,9465,9465,9466,9467,9468,9469,9470,9471,9472,9473,9474,9151,9476,9477,9478,9155,9480,9481,9482,9484,9485,9161,9487,9488,9490,9491,9493,9494,9496,9497,9169,9498,9171,9500,9173,9501,9503,9176,9505,9178,9506,9508,9510,9512,9514,9516,9518,9185,9519,9187,9521,9523,9190,9524,9192,9526,9194,9527,9528,9530,9531,9533,9534,9536,9537,9202,9539,9540,9542,9543,9544,9208,9546,9547,9548,9212,9550,9551,9552,9553,9554,9555,9556,9557,9558,9559,9559,9559,9560,9561,9562,9563,9564,9565,9566,9567,9568,9232,9570,9571,9572,9236,9574,9575,9576,9578,9579,9242,9581,9582,9584,9585,9587,9588,9590,9591,9250,9592,9252,9594,9254,9595,9597,9257,9599,9259,9600,9602,9604,9606,9608,9610,9612,9266,9613,9268,9615,9617,9271,9618,9273,9620,9275,9621,9622,9624,9625,9627,9628,9630,9631,9283,9633,9634,9636,9637,9638,9289,9640,9641,9642,9293,9644,9645,9646,9647,9648,9649,9650,9651,9652,9653,9653,9653,9654,9655,9656,9657,9658,9659,9660,9661,9662,9313,9664,9665,9666,9317,9668,9669,9670,9672,9673,9323,9675,9676,9678,9679,9681,9682,9684,9685,9331,9686,9333,9688,9335,9689,9691,9338,9693,9340,9694,9696,9698,9700,9702,9704,9706,9347,9707,9349,9709,9711,9352,9712,9354,9714,9356,9715,9716,9718,9719,9721,9722,9724,9725,9364,9727,9728,9730,9731,9732,9370,9734,9735,9736,9374,9738,9739,9740,9741,9742,9743,9744,9745,9746,9747,9747,9747,9748,9749,9750,9751,9752,9753,9754,9755,9756,9394,9758,9759,9760,9398,9762,9763,9764,9766,9767,9404,9769,9770,9772,9773,9775,9776,9778,9779,9412,9780,9414,9782,9416,9783,9785,9419,9787,9421,9788,9790,9792,9794,9796,9798,9800,9428,9801,9430,9803,9805,9433,9806,9435,9808,9437,9809,9810,9812,9813,9815,9816,9818,9819,9445,9821,9822,9824,9825,9826,9451,9828,9829,9830,9455,9832,9833,9834,9835,9836,9837,9838,9839,9840,9465,9841,9841,9842,9843,9844,9845,9846,9847,9848,9849,9850,9475,9852,9853,9854,9855,9479,9856,9857,9858,9483,9860,9861,9486,9862,9863,9489,9865,9492,9867,9495,9869,9871,9872,9499,9873,9875,9502,9877,9504,9878,9880,9507,9509,9511,9884,9513,9515,9517,9888,9890,9520,9891,9522,9893,9895,9525,9896,9897,9899,9529,9901,9532,9903,9535,9905,9906,9538,9907,9908,9541,9910,9911,9912,9545,9913,9914,9915,9916,9549,9918,9919,9920,9921,9922,9923,9924,9925,9926,9927,9927,9927,9928,9929,9930,9931,9932,9933,9934,9935,9936,9569,9938,9939,9940,9941,9573,9942,9943,9944,9577,9946,9947,9580,9948,9949,9583,9951,9586,9953,9589,9955,9957,9958,9593,9959,9961,9596,9963,9598,9964,9966,9601,9603,9605,9970,9607,9609,9611,9974,9976,9614,9977,9616,9979,9981,9619,9982,9983,9985,9623,9987,9626,9989,9629,9991,9992,9632,9993,9994,9635,9996,9997,9998,9639,9999,10000,10001,10002,9643,10004,10005,10006,10007,10008,10009,10010,10011,10012,10013,10013,10013,10014,10015,10016,10017,10018,10019,10020,10021,10022,9663,10024,10025,10026,10027,9667,10028,10029,10030,9671,10032,10033,9674,10034,10035,9677,10037,9680,10039,9683,10041,10043,10044,9687,10045,10047,9690,10049,9692,10050,10052,9695,9697,9699,10056,9701,9703,9705,10060,10062,9708,10063,9710,10065,10067,9713,10068,10069,10071,9717,10073,9720,10075,9723,10077,10078,9726,10079,10080,9729,10082,10083,10084,9733,10085,10086,10087,10088,9737,10090,10091,10092,10093,10094,10095,10096,10097,10098,10099,10099,10099,10100,10101,10102,10103,10104,10105,10106,10107,10108,9757,10110,10111,10112,10113,9761,10114,10115,10116,9765,10118,10119,9768,10120,10121,9771,10123,9774,10125,9777,10127,10129,10130,9781,10131,10133,9784,10135,9786,10136,10138,9789,9791,9793,10142,9795,9797,9799,10146,10148,9802,10149,9804,10151,10153,9807,10154,10155,10157,9811,10159,9814,10161,9817,10163,10164,9820,10165,10166,9823,10168,10169,10170,9827,10171,10172,10173,10174,9831,10176,10177,10178,10179,10180,10181,10182,10183,10184,9841,10185,10185,10186,10187,10188,10189,10190,10191,10192,10193,10194,9851,10196,10197,10198,10199,10201,10202,10203,9859,10205,10206,10208,10209,9864,10211,9866,10213,9868,10215,9870,10217,10219,9874,10221,9876,10222,10224,9879,10226,9881,10227,9882,10228,9883,10229,10231,9885,10232,9886,10233,9887,10234,9889,10236,10238,9892,10239,9894,10241,10243,9898,10245,9900,10247,9902,10249,9904,10251,10252,10254,10255,9909,10257,10258,10259,10261,10262,10263,10264,9917,10266,10267,10268,10269,10270,10271,10272,10273,10274,10275,10275,10275,10276,10277,10278,10279,10280,10281,10282,10283,10284,9937,10286,10287,10288,10289,10291,10292,10293,9945,10295,10296,10298,10299,9950,10301,9952,10303,9954,10305,9956,10307,10309,9960,10311,9962,10312,10314,9965,10316,9967,10317,9968,10318,9969,10319,10321,9971,10322,9972,10323,9973,10324,9975,10326,10328,9978,10329,9980,10331,10333,9984,10335,9986,10337,9988,10339,9990,10341,10342,10344,10345,9995,10347,10348,10349,10351,10352,10353,10354,10003,10356,10357,10358,10359,10360,10361,10362,10363,10364,10365,10365,10365,10366,10367,10368,10369,10370,10371,10372,10373,10374,10023,10376,10377,10378,10379,10381,10382,10383,10031,10385,10386,10388,10389,10036,10391,10038,10393,10040,10395,10042,10397,10399,10046,10401,10048,10402,10404,10051,10406,10053,10407,10054,10408,10055,10409,10411,10057,10412,10058,10413,10059,10414,10061,10416,10418,10064,10419,10066,10421,10423,10070,10425,10072,10427,10074,10429,10076,10431,10432,10434,10435,10081,10437,10438,10439,10441,10442,10443,10444,10089,10446,10447,10448,10449,10450,10451,10452,10453,10454,10455,10455,10455,10456,10457,10458,10459,10460,10461,10462,10463,10464,10109,10466,10467,10468,10469,10471,10472,10473,10117,10475,10476,10478,10479,10122,10481,10124,10483,10126,10485,10128,10487,10489,10132,10491,10134,10492,10494,10137,10496,10139,10497,10140,10498,10141,10499,10501,10143,10502,10144,10503,10145,10504,10147,10506,10508,10150,10509,10152,10511,10513,10156,10515,10158,10517,10160,10519,10162,10521,10522,10524,10525,10167,10527,10528,10529,10531,10532,10533,10534,10175,10536,10537,10538,10539,10540,10541,10542,10543,10544,10185,10545,10545,10546,10547,10548,10549,10550,10551,10552,10553,10554,10195,10556,10557,10558,10559,10200,10561,10562,10204,10564,10565,10207,10567,10210,10569,10570,10212,10571,10572,10214,10573,10216,10575,10218,10577,10220,10578,10580,10223,10582,10225,10583,10585,10587,10589,10230,10592,10594,10596,10598,10235,10599,10237,10601,10603,10240,10604,10242,10606,10244,10608,10246,10609,10610,10248,10611,10612,10250,10614,10253,10616,10617,10256,10619,10620,10260,10622,10623,10624,10625,10265,10627,10628,10629,10630,10631,10632,10633,10634,10635,10636,10636,10636,10637,10638,10639,10640,10641,10642,10643,10644,10645,10285,10647,10648,10649,10650,10290,10652,10653,10294,10655,10656,10297,10658,10300,10660,10661,10302,10662,10663,10304,10664,10306,10666,10308,10668,10310,10669,10671,10313,10673,10315,10674,10676,10678,10680,10320,10683,10685,10687,10689,10325,10690,10327,10692,10694,10330,10695,10332,10697,10334,10699,10336,10700,10701,10338,10702,10703,10340,10705,10343,10707,10708,10346,10710,10711,10350,10713,10714,10715,10716,10355,10718,10719,10720,10721,10722,10723,10724,10725,10726,10727,10727,10727,10728,10729,10730,10731,10732,10733,10734,10735,10736,10375,10738,10739,10740,10741,10380,10743,10744,10384,10746,10747,10387,10749,10390,10751,10752,10392,10753,10754,10394,10755,10396,10757,10398,10759,10400,10760,10762,10403,10764,10405,10765,10767,10769,10771,10410,10774,10776,10778,10780,10415,10781,10417,10783,10785,10420,10786,10422,10788,10424,10790,10426,10791,10792,10428,10793,10794,10430,10796,10433,10798,10799,10436,10801,10802,10440,10804,10805,10806,10807,10445,10809,10810,10811,10812,10813,10814,10815,10816,10817,10818,10818,10818,10819,10820,10821,10822,10823,10824,10825,10826,10827,10465,10829,10830,10831,10832,10470,10834,10835,10474,10837,10838,10477,10840,10480,10842,10843,10482,10844,10845,10484,10846,10486,10848,10488,10850,10490,10851,10853,10493,10855,10495,10856,10858,10860,10862,10500,10865,10867,10869,10871,10505,10872,10507,10874,10876,10510,10877,10512,10879,10514,10881,10516,10882,10883,10518,10884,10885,10520,10887,10523,10889,10890,10526,10892,10893,10530,10895,10896,10897,10898,10535,10900,10901,10902,10903,10904,10905,10906,10907,10908,10545];
var count_per_radius = [1,8,16,20,24,40,36,48,56,56,68,64,80,92,88,96,96,116,120,120,124,144,136,140,152,168,176,164,168,192,188,208,200,208,228,208,232,228,256,248,236,272,264,288,276,272,296,292,312,304,336,324,312,344,324,376,344,360,364,368];
var radius_offset = [0,1,9,25,45,69,109,145,193,249,305,373,437,517,609,697,793,889,1005,1125,1245,1369,1513,1649,1789,1941,2109,2285,2449,2617,2809,2997,3205,3405,3613,3841,4049,4281,4509,4765,5013,5249,5521,5785,6073,6349,6621,6917,7209,7521,7825,8161,8485,8797,9141,9465,9841,10185,10545,10909];
// End of generated.

var connected = new Array(towards_center.length).fill(true);
