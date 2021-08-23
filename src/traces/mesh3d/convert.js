'use strict';

var createMesh = require('gl-mesh3d');
var triangulate = require('delaunay-triangulate');
var alphaShape = require('alpha-shape');
var convexHull = require('convex-hull');

var parseColorScale = require('../../lib/gl_format_color').parseColorScale;
var str2RgbaArray = require('../../lib/str2rgbarray');
var extractOpts = require('../../components/colorscale').extractOpts;
var zip3 = require('../../plots/gl3d/zip3');

function Mesh3DTrace(scene, mesh, uid) {
    this.scene = scene;
    this.uid = uid;
    this.mesh = mesh;
    this.name = '';
    this.color = '#fff';
    this.data = null;
    this.showContour = false;
}

var proto = Mesh3DTrace.prototype;

proto.handlePick = function(selection) {
    if(selection.object === this.mesh) {
        var selectIndex = selection.index = selection.data.index;

        if(selection.data._cellCenter) {
            selection.traceCoordinate = selection.data.dataCoordinate;
        } else {
            selection.traceCoordinate = [
                this.data.x[selectIndex],
                this.data.y[selectIndex],
                this.data.z[selectIndex]
            ];
        }

        var text = this.data.hovertext || this.data.text;
        if(Array.isArray(text) && text[selectIndex] !== undefined) {
            selection.textLabel = text[selectIndex];
        } else if(text) {
            selection.textLabel = text;
        }

        return true;
    }
};

function parseColorArray(colors) {
    var b = [];
    var len = colors.length;
    for(var i = 0; i < len; i++) {
        b[i] = str2RgbaArray(colors[i]);
    }
    return b;
}

// Unpack position data
function toDataCoords(axis, coord, scale, calendar) {
    var b = [];
    var len = coord.length;
    for(var i = 0; i < len; i++) {
        b[i] = axis.d2l(coord[i], 0, calendar) * scale;
    }
    return b;
}

// Round indices if passed as floats
function toRoundIndex(a) {
    var b = [];
    var len = a.length;
    for(var i = 0; i < len; i++) {
        b[i] = Math.round(a[i]);
    }
    return b;
}

function cart2sph(c) {
    var x = c[0];
    var y = c[1];
    var z = c[2];
    var r = Math.sqrt(x * x + y * y + z * z);
    var az = Math.atan2(y, x);
    var el = r == 0 ? 0 : Math.acos(z / r);
    return [r, el, az];
}

function sph2cart(s) {
    var r = s[0];
    var el = s[1];
    var az = s[2];
    var x = r * Math.cos(az) * Math.sin(el);
    var y = r * Math.sin(az) * Math.sin(el);
    var z = r * Math.cos(el);
    return [x, y, z];
}

function polarTriangulate(positions) {
    var b = [];
    var len = positions.length;
    for(var i = 0; i < len; i++) {
        var sph = cart2sph(positions[i]);
        b[i] = [sph[1], sph[2]];
        b[i + len] = [sph[1], sph[2] + 2*Math.PI];
        b[i + 2*len] = [sph[1], sph[2] - 2*Math.PI];
    }
    var cells = triangulate(b);
    var filtered = [];
    var n = 0;
    for (var i = 0; i < cells.length; i++) {
        var include = false;
        for (var j = 0; j < 3; j++) {
            var az = b[cells[i][j]][1];
            if (az >= -Math.PI && az <= Math.PI) {
                include = true;
            }
        }
        if (!include) {
            continue;
        }
        var candidate = [cells[i][0] % len, cells[i][1] % len, cells[i][2] % len];
        if (candidate[0] == candidate[1] ||
            candidate[0] == candidate[2] ||
            candidate[1] == candidate[2]) {
            continue;
        }

        var unique = true;
        for (var k = 0; k < filtered.length; k++) {
            if ((candidate[0] == filtered[k][0] &&
                 candidate[1] == filtered[k][1] &&
                 candidate[2] == filtered[k][2])) {
                unique = false;
                break;
            }
        }
        if (unique) {
            filtered[n] = candidate;
            n++;
            continue;
        }
    }
    return filtered;
}

function delaunayCells(delaunayaxis, positions) {
    if (delaunayaxis == 'r') {
        return polarTriangulate(positions);
    }
    var d = ['x', 'y', 'z'].indexOf(delaunayaxis);
    var b = [];
    var len = positions.length;
    for(var i = 0; i < len; i++) {
        b[i] = [positions[i][(d + 1) % 3], positions[i][(d + 2) % 3]];
    }
    return triangulate(b);
}

// Validate indices
function hasValidIndices(list, numVertices) {
    var len = list.length;
    for(var i = 0; i < len; i++) {
        if(list[i] <= -0.5 || list[i] >= numVertices - 0.5) { // Note: the indices would be rounded -0.49 is valid.
            return false;
        }
    }
    return true;
}

proto.update = function(data) {
    var scene = this.scene;
    var layout = scene.fullSceneLayout;

    this.data = data;

    var numVertices = data.x.length;

    var positions = zip3(
        toDataCoords(layout.xaxis, data.x, scene.dataScale[0], data.xcalendar),
        toDataCoords(layout.yaxis, data.y, scene.dataScale[1], data.ycalendar),
        toDataCoords(layout.zaxis, data.z, scene.dataScale[2], data.zcalendar)
    );

    var cells;
    if(data.i && data.j && data.k) {
        if(
            data.i.length !== data.j.length ||
            data.j.length !== data.k.length ||
            !hasValidIndices(data.i, numVertices) ||
            !hasValidIndices(data.j, numVertices) ||
            !hasValidIndices(data.k, numVertices)
        ) {
            return;
        }
        cells = zip3(
            toRoundIndex(data.i),
            toRoundIndex(data.j),
            toRoundIndex(data.k)
        );
    } else if(data.alphahull === 0) {
        cells = convexHull(positions);
    } else if(data.alphahull > 0) {
        cells = alphaShape(data.alphahull, positions);
    } else {
        cells = delaunayCells(data.delaunayaxis, positions);
    }

    var config = {
        positions: positions,
        cells: cells,
        lightPosition: [data.lightposition.x, data.lightposition.y, data.lightposition.z],
        ambient: data.lighting.ambient,
        diffuse: data.lighting.diffuse,
        specular: data.lighting.specular,
        roughness: data.lighting.roughness,
        fresnel: data.lighting.fresnel,
        vertexNormalsEpsilon: data.lighting.vertexnormalsepsilon,
        faceNormalsEpsilon: data.lighting.facenormalsepsilon,
        opacity: data.opacity,
        contourEnable: data.contour.show,
        contourColor: str2RgbaArray(data.contour.color).slice(0, 3),
        contourWidth: data.contour.width,
        useFacetNormals: data.flatshading
    };

    if(data.intensity) {
        var cOpts = extractOpts(data);
        this.color = '#fff';
        var mode = data.intensitymode;
        config[mode + 'Intensity'] = data.intensity;
        config[mode + 'IntensityBounds'] = [cOpts.min, cOpts.max];
        config.colormap = parseColorScale(data);
    } else if(data.vertexcolor) {
        this.color = data.vertexcolor[0];
        config.vertexColors = parseColorArray(data.vertexcolor);
    } else if(data.facecolor) {
        this.color = data.facecolor[0];
        config.cellColors = parseColorArray(data.facecolor);
    } else {
        this.color = data.color;
        config.meshColor = str2RgbaArray(data.color);
    }

    // Update mesh
    this.mesh.update(config);
};

proto.dispose = function() {
    this.scene.glplot.remove(this.mesh);
    this.mesh.dispose();
};

function createMesh3DTrace(scene, data) {
    var gl = scene.glplot.gl;
    var mesh = createMesh({gl: gl});
    var result = new Mesh3DTrace(scene, mesh, data.uid);
    mesh._trace = result;
    result.update(data);
    scene.glplot.add(mesh);
    return result;
}

module.exports = createMesh3DTrace;
